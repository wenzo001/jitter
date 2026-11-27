//! 调度器：tokio 定时器驱动的每日窗口 / 循环执行。
//!
//! 语义复用已移植并通过测试的 schedule/window 模块：
//! 计划、恢复、迟到判定、暂停区间全部来自同一套核心。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use jitter_core::db::NewLogInput;
use jitter_core::executor;
use jitter_core::schedule::{self, StoredSchedule};
use jitter_core::window::PauseInterval;

struct Running {
    cancel: CancellationToken,
    handle: Option<JoinHandle<()>>,
    generation: u64,
    /// 本次执行开始的时刻（ms），任务卡上的「执行中」徽标用它显示时长。
    started_at: i64,
}

pub struct RunningGuard {
    task_id: String,
    generation: u64,
    pub(crate) cancel: CancellationToken,
    finished: bool,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if !self.finished {
            finish_run(&self.task_id, self.generation);
        }
    }
}

struct ScheduleNextOnDrop {
    task: jitter_core::db::TaskRow,
    spec: jitter_core::schedule::ScheduleSpec,
    target: i64,
    generation: u64,
}

impl Drop for ScheduleNextOnDrop {
    fn drop(&mut self) {
        schedule_next_after(&self.task, &self.spec, self.target, self.generation);
    }
}

struct ScheduledTimer {
    handle: JoinHandle<()>,
    generation: u64,
}

pub enum RunAdmission {
    Manual,
    Scheduled(u64),
    Startup,
}

struct SchedulerState {
    timers: HashMap<String, ScheduledTimer>,
    schedule_generations: HashMap<String, u64>,
    running: HashMap<String, Running>,
    admission_blocked: HashMap<String, usize>,
}

static STATE: OnceLock<Mutex<SchedulerState>> = OnceLock::new();
static SWEEP_STOP: AtomicBool = AtomicBool::new(false);
static SWEEP_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static STARTUP_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static ACTIVE_RUNS: AtomicI64 = AtomicI64::new(0);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_TIMER_GENERATION: AtomicU64 = AtomicU64::new(1);
static RUNS_IDLE: Notify = Notify::const_new();

fn state() -> &'static Mutex<SchedulerState> {
    STATE.get_or_init(|| Mutex::new(SchedulerState {
        timers: HashMap::new(),
        schedule_generations: HashMap::new(),
        running: HashMap::new(),
        admission_blocked: HashMap::new(),
    }))
}

fn stored_of(task: &jitter_core::db::TaskRow) -> StoredSchedule {
    StoredSchedule {
        schedule_kind: Some(task.schedule_kind.clone()),
        window_start: Some(task.window_start.clone()),
        window_end: Some(task.window_end.clone()),
        daily_jitter_minutes: Some(task.daily_jitter_minutes),
        interval_seconds: task.interval_seconds,
        interval_jitter_seconds: Some(task.interval_jitter_seconds),
        interval_start_at: task.interval_start_at,
    }
}

fn task_spec(task: &jitter_core::db::TaskRow) -> Option<jitter_core::schedule::ScheduleSpec> {
    schedule::schedule_of(&stored_of(task)).ok()
}

/// 启动：恢复全部 active 任务的计划 + 兜底巡检。
pub async fn start() -> anyhow::Result<usize> {
    let tasks = jitter_core::db::list_tasks()?;
    SWEEP_STOP.store(false, Ordering::SeqCst);
    let mut recovered = 0usize;
    for task in tasks {
        if task.status == "active" {
            schedule_new_task(&task.id);
            recovered += 1;
        }
    }
    // 每分钟一次兜底巡检：计划丢失就补上，并做保留清理。
    let sweep = tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if SWEEP_STOP.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            sweep_once().await;
        }
    });
    *SWEEP_HANDLE.lock().expect("sweep handle") = Some(sweep);
    Ok(recovered)
}

/// 进程启动后，对勾选「开机后自动执行一次」的任务各执行一次。
/// 只在 main 启动时调用；恢复备份 / 导入后重启调度不会触发。
/// 启动瞬间先固定任务清单，延迟 15 秒等网络就绪后再逐个执行；
/// 执行前重新读取任务，尊重这 15 秒内用户做的停止/取消勾选/暂停。
pub fn spawn_startup_runs() {
    let Ok(tasks) = jitter_core::db::list_tasks() else {
        return;
    };
    let ids: Vec<String> = tasks
        .into_iter()
        .filter(|task| task.run_on_startup == 1 && task.status == "active")
        .map(|task| task.id)
        .collect();
    if ids.is_empty() {
        return;
    }
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        if SWEEP_STOP.load(Ordering::SeqCst) {
            return;
        }
        for id in ids {
            if SWEEP_STOP.load(Ordering::SeqCst) {
                return;
            }
            let Ok(Some(task)) = jitter_core::db::get_task(&id) else {
                continue;
            };
            if task.run_on_startup == 0 || task.status != "active" {
                continue;
            }
            // 暂停区间内不补跑（与定时调度保持一致）。
            let now = executor::now_ms();
            if let (Some(from), Some(until)) = (task.paused_from, task.paused_until) {
                if now >= from && now < until {
                    continue;
                }
            }
            let Some((run, task)) = begin_task_run(
                &task.id,
                CancellationToken::new(),
                RunAdmission::Startup,
            ) else {
                continue;
            };
            tracing::info!("[scheduler] startup run {}", task.id);
            let run_cancel = run.cancel.clone();
            let finish_id = task.id.clone();
            let generation = run.generation;
            let handle = tokio::spawn(async move {
                let _ = executor::execute_task_run(
                    &task,
                    &run_cancel,
                    jitter_core::types::RunSource::Startup,
                )
                .await;
                drop(run);
            });
            attach_run_handle(&finish_id, generation, handle);
            // 多任务错开半秒，避免开机瞬间同时发请求。
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    *STARTUP_HANDLE.lock().expect("startup handle") = Some(handle);
}

pub async fn stop() {
    SWEEP_STOP.store(true, Ordering::SeqCst);
    let mut handles = {
        let mut guard = state().lock().expect("state");
        let mut handles = Vec::new();
        for (_, running) in guard.running.drain() {
            running.cancel.cancel();
            if let Some(handle) = running.handle {
                handles.push(handle);
            }
        }
        for (_, timer) in guard.timers.drain() {
            timer.handle.abort();
            handles.push(timer.handle);
        }
        guard.schedule_generations.clear();
        guard.admission_blocked.clear();
        handles
    };
    if let Some(handle) = SWEEP_HANDLE.lock().expect("sweep handle").take() {
        handle.abort();
        handles.push(handle);
    }
    if let Some(handle) = STARTUP_HANDLE.lock().expect("startup handle").take() {
        handle.abort();
        handles.push(handle);
    }
    for handle in handles {
        let _ = handle.await;
    }
    wait_for_runs_idle().await;
}

async fn wait_for_runs_idle() {
    loop {
        let notified = RUNS_IDLE.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if ACTIVE_RUNS.load(Ordering::SeqCst) == 0 {
            return;
        }
        notified.await;
    }
}

/// 为一个任务（重新）排下一次执行。
pub fn schedule_new_task(task_id: &str) {
    if SWEEP_STOP.load(Ordering::SeqCst) {
        return;
    }
    let Ok(Some(task)) = jitter_core::db::get_task(task_id) else {
        return;
    };
    if task.status != "active" {
        return;
    }
    let Some(spec) = task_spec(&task) else {
        return;
    };
    let pause = match (task.paused_from, task.paused_until) {
        (Some(from), Some(until)) => Some(PauseInterval { from, until }),
        _ => None,
    };
    let now = executor::now_ms();
    let target = match schedule::plan_schedule_new(now, &spec, pause, &mut rand()) {
        Ok(target) => target,
        Err(_) => return,
    };
    arm_timer(task_id.to_string(), target);
}

/// 暂停结束时刻的定点恢复。
pub fn schedule_resume(task_id: &str, resume_at: i64) {
    if SWEEP_STOP.load(Ordering::SeqCst) {
        return;
    }
    let delay = (resume_at - executor::now_ms()).max(0) as u64;
    let id = task_id.to_string();
    let resume_id = id.clone();
    let generation = NEXT_TIMER_GENERATION.fetch_add(1, Ordering::SeqCst);
    let (start_tx, start_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = start_rx.await;
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        let current = {
            let mut guard = state().lock().expect("state");
            if guard
                .timers
                .get(&resume_id)
                .is_some_and(|timer| timer.generation == generation)
            {
                guard.timers.remove(&resume_id);
                guard.schedule_generations.remove(&resume_id);
                true
            } else {
                false
            }
        };
        if current {
            schedule_new_task(&resume_id);
        }
    });
    let mut guard = state().lock().expect("state");
    if SWEEP_STOP.load(Ordering::SeqCst) {
        handle.abort();
        return;
    }
    if let Some(old) = guard.timers.insert(
        id.clone(),
        ScheduledTimer {
            handle,
            generation,
        },
    ) {
        old.handle.abort();
    }
    guard.schedule_generations.insert(id, generation);
    drop(guard);
    let _ = start_tx.send(());
}

pub fn cancel_schedule(task_id: &str) {
    let mut guard = state().lock().expect("state");
    if let Some(timer) = guard.timers.remove(task_id) {
        timer.handle.abort();
    }
    guard.schedule_generations.remove(task_id);
}

pub fn block_task_runs(task_id: &str) {
    let mut guard = state().lock().expect("state");
    if let Some(timer) = guard.timers.remove(task_id) {
        timer.handle.abort();
    }
    guard.schedule_generations.remove(task_id);
    let blocked = guard.admission_blocked.entry(task_id.to_string()).or_default();
    *blocked += 1;
}

pub fn finish_task_transition(task_id: &str) {
    let mut guard = state().lock().expect("state");
    if let Some(count) = guard.admission_blocked.get_mut(task_id) {
        if *count <= 1 {
            guard.admission_blocked.remove(task_id);
        } else {
            *count -= 1;
        }
    }
}

pub fn cancel_task(task_id: &str) {
    let mut guard = state().lock().expect("state");
    if let Some(timer) = guard.timers.remove(task_id) {
        timer.handle.abort();
    }
    guard.schedule_generations.remove(task_id);
    if let Some(running) = guard.running.remove(task_id) {
        running.cancel.cancel();
        if let Some(handle) = running.handle {
            handle.abort();
        }
    }
}

fn reserve_run_locked(
    guard: &mut SchedulerState,
    task_id: &str,
    cancel: CancellationToken,
) -> RunningGuard {
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
    guard.running.insert(
        task_id.to_string(),
        Running {
            cancel: cancel.clone(),
            handle: None,
            generation,
            started_at: executor::now_ms(),
        },
    );
    ACTIVE_RUNS.fetch_add(1, Ordering::SeqCst);
    RunningGuard {
        task_id: task_id.to_string(),
        generation,
        cancel,
        finished: false,
    }
}

#[cfg(test)]
fn begin_run(task_id: &str, cancel: CancellationToken) -> Option<RunningGuard> {
    let mut guard = state().lock().expect("state");
    if SWEEP_STOP.load(Ordering::SeqCst) || guard.running.contains_key(task_id) {
        return None;
    }
    Some(reserve_run_locked(&mut guard, task_id, cancel))
}

pub fn begin_task_run(
    task_id: &str,
    cancel: CancellationToken,
    admission: RunAdmission,
) -> Option<(RunningGuard, jitter_core::db::TaskRow)> {
    let mut guard = state().lock().expect("state");
    if SWEEP_STOP.load(Ordering::SeqCst)
        || guard.admission_blocked.contains_key(task_id)
        || guard.running.contains_key(task_id)
    {
        return None;
    }
    let task = jitter_core::db::get_task(task_id).ok().flatten()?;
    if !matches!(admission, RunAdmission::Manual) && task.status != "active" {
        return None;
    }
    if let RunAdmission::Scheduled(expected) = admission {
        if guard.schedule_generations.get(task_id) != Some(&expected) {
            return None;
        }
    }
    let run = reserve_run_locked(&mut guard, task_id, cancel);
    Some((run, task))
}

fn attach_run_handle(task_id: &str, generation: u64, handle: JoinHandle<()>) {
    let mut guard = state().lock().expect("state");
    let Some(running) = guard.running.get_mut(task_id) else {
        handle.abort();
        return;
    };
    if running.generation != generation || running.cancel.is_cancelled() {
        handle.abort();
    } else {
        running.handle = Some(handle);
    }
}

/// 一次执行完成：只清理运行状态，**不**排下一次。
/// 定时触发的调用方负责用 schedule_next_after（跑完后的下一次，
/// daily 会排明天，不会在同一窗口内连环重跑）；手动执行不影响计划。
fn finish_run(task_id: &str, generation: u64) {
    let mut guard = state().lock().expect("state");
    if guard
        .running
        .get(task_id)
        .is_some_and(|running| running.generation == generation)
    {
        guard.running.remove(task_id);
    }
    ACTIVE_RUNS.fetch_sub(1, Ordering::SeqCst);
    RUNS_IDLE.notify_waiters();
}

/// 正在执行的任务 → 开始时刻（ms）。
pub fn running_tasks() -> std::collections::HashMap<String, i64> {
    let guard = state().lock().expect("state");
    guard.running.iter().map(|(id, running)| (id.clone(), running.started_at)).collect()
}

pub fn running_count() -> i64 {
    ACTIVE_RUNS.load(Ordering::SeqCst)
}

thread_local! {
    static RAND_STATE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn rand() -> impl FnMut() -> f64 {
    || {
        RAND_STATE.with(|state| {
            let mut seed = state.get();
            if seed == 0 {
                seed = (executor::now_ms() as u64)
                    ^ ((std::process::id() as u64) << 32)
                    ^ 0x9E37_79B9_7F4A_7C15;
            }
            seed ^= seed >> 12;
            seed ^= seed << 25;
            seed ^= seed >> 27;
            state.set(seed);
            let value = seed.wrapping_mul(0x2545_F491_4F6C_DD1D);
            (value >> 11) as f64 / (1u64 << 53) as f64
        })
    }
}

/// 挂一个到点执行的定时器；到点后判定是否还落在窗口里（迟到 → 记 missed）。
fn arm_timer(task_id: String, target: i64) {
    arm_timer_inner(task_id, target, None);
}

fn arm_timer_inner(task_id: String, target: i64, expected_generation: Option<u64>) {
    if SWEEP_STOP.load(Ordering::SeqCst) {
        return;
    }
    let delay = (target - executor::now_ms()).max(0) as u64;
    tracing::info!("[scheduler] arm {task_id}: target={target} delay={delay}ms");
    let fire_id = task_id.clone();
    let generation = NEXT_TIMER_GENERATION.fetch_add(1, Ordering::SeqCst);
    let (start_tx, start_rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = start_rx.await;
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        fire(fire_id, target, generation).await;
    });
    let mut guard = state().lock().expect("state");
    if SWEEP_STOP.load(Ordering::SeqCst)
        || expected_generation
            .is_some_and(|expected| guard.schedule_generations.get(&task_id) != Some(&expected))
        || jitter_core::db::get_task(&task_id)
            .ok()
            .flatten()
            .is_none_or(|task| task.status != "active")
    {
        handle.abort();
        return;
    }
    if let Some(old) = guard.timers.insert(
        task_id.clone(),
        ScheduledTimer {
            handle,
            generation,
        },
    ) {
        old.handle.abort();
    }
    guard.schedule_generations.insert(task_id.clone(), generation);
    let _ = jitter_core::db::update_task_next_run(&task_id, Some(target), executor::now_ms());
    drop(guard);
    let _ = start_tx.send(());
}

fn discard_schedule_generation(task_id: &str) {
    state()
        .lock()
        .expect("state")
        .schedule_generations
        .remove(task_id);
}

async fn fire(task_id: String, target: i64, timer_generation: u64) {
    if SWEEP_STOP.load(Ordering::SeqCst) {
        return;
    }
    let is_current = {
        let mut guard = state().lock().expect("state");
        if guard
            .timers
            .get(&task_id)
            .is_some_and(|timer| timer.generation == timer_generation)
        {
            guard.timers.remove(&task_id);
            true
        } else {
            false
        }
    };
    if !is_current {
        return;
    }
    tracing::info!("[scheduler] fire {task_id}: target={target}");
    let Ok(Some(task)) = jitter_core::db::get_task(&task_id) else {
        discard_schedule_generation(&task_id);
        return;
    };
    if task.status != "active" {
        discard_schedule_generation(&task_id);
        return;
    }
    let Some(spec) = task_spec(&task) else {
        discard_schedule_generation(&task_id);
        return;
    };
    let now = executor::now_ms();

    // 迟到判定：daily 按窗口是否仍开着；interval 按容差。
    let too_late = if spec.kind == schedule::ScheduleKind::Daily {
        let window = match &spec.window {
            Some(window) => window,
            None => return,
        };
        jitter_core::window::classify_timer_fire(now, target, window)
            == jitter_core::window::TimerFireVerdict::Miss
    } else {
        schedule::is_missed_non_daily(now, target, &spec)
    };
    if too_late {
        let _ = jitter_core::db::insert_log(&NewLogInput {
            task_id: task_id.clone(),
            executed_at: now,
            error: Some(format!("错过计划时刻 {}（进程可能挂起或重启）", target)),
            kind: Some(jitter_core::types::LogKind::Missed),
            run_source: Some("scheduled".to_string()),
            ..Default::default()
        });
        schedule_next_after(&task, &spec, target, timer_generation);
        return;
    }

    let Some((run, task)) =
        begin_task_run(&task_id, CancellationToken::new(), RunAdmission::Scheduled(timer_generation))
    else {
        schedule_next_after(&task, &spec, target, timer_generation);
        return;
    };
    tracing::info!("[scheduler] execute {task_id} (定时触发)");
    let run_cancel = run.cancel.clone();
    let run_task_id = task_id.clone();
    let generation = run.generation;
    let handle = tokio::spawn(async move {
        let next = ScheduleNextOnDrop {
            task: task.clone(),
            spec: spec.clone(),
            target,
            generation: timer_generation,
        };
        let _ = executor::execute_task_run(
            &task,
            &run_cancel,
            jitter_core::types::RunSource::Scheduled,
        )
        .await;
        drop(next);
        drop(run);
    });
    attach_run_handle(&run_task_id, generation, handle);
}

/// 一次执行完成后的下一次计划（防漂移）。
fn schedule_next_after(
    task: &jitter_core::db::TaskRow,
    spec: &schedule::ScheduleSpec,
    fired_at: i64,
    generation: u64,
) {
    if SWEEP_STOP.load(Ordering::SeqCst)
        || state()
            .lock()
            .expect("state")
            .schedule_generations
            .get(&task.id)
            != Some(&generation)
    {
        return;
    }
    let Ok(Some(current)) = jitter_core::db::get_task(&task.id) else {
        return;
    };
    if current.status != "active" || task_spec(&current).as_ref() != Some(spec) {
        return;
    }
    let now = executor::now_ms();
    let pause = match (current.paused_from, current.paused_until) {
        (Some(from), Some(until)) => Some(PauseInterval { from, until }),
        _ => None,
    };
    let target = match schedule::plan_schedule_after(now, spec, fired_at, pause, &mut rand()) {
        Ok(target) => target,
        Err(_) => return,
    };
    arm_timer_inner(current.id.clone(), target, Some(generation));
}

/// 兜底巡检：计划丢失就补；顺带做保留清理。
async fn sweep_once() {
    let Ok(tasks) = jitter_core::db::list_tasks() else {
        return;
    };
    let now = executor::now_ms();
    for task in tasks {
        if task.status != "active" {
            continue;
        }
        let Some(spec) = task_spec(&task) else {
            continue;
        };
        let needs_plan = match task.next_run_at {
            None => true,
            Some(next_run_at) => {
                // 计划已过期且早已触发过：恢复式重排。
                next_run_at <= now && !state().lock().expect("state").timers.contains_key(&task.id)
            }
        };
        if needs_plan {
            let pause = match (task.paused_from, task.paused_until) {
                (Some(from), Some(until)) => Some(PauseInterval { from, until }),
                _ => None,
            };
            let plan = schedule::plan_schedule_recovery(now, &spec, task.next_run_at, pause, &mut rand());
            if let Ok(plan) = plan {
                if let Some(missed) = plan.missed_planned_at {
                    let _ = jitter_core::db::insert_log(&NewLogInput {
                        task_id: task.id.clone(),
                        executed_at: now,
                        error: Some(format!("错过计划时刻 {missed}（启动恢复）")),
                        kind: Some(jitter_core::types::LogKind::Missed),
                        run_source: Some("scheduled".to_string()),
                        ..Default::default()
                    });
                }
                arm_timer(task.id.clone(), plan.target);
            }
        }
    }
    // 保留清理（分批）。
    let config = jitter_core::config::get_active_config();
    if let Ok(days) = jitter_core::db::get_effective_retention_days(config.log_retention_days) {
        let _ = jitter_core::db::prune_logs(now, days, config.log_max_rows_per_task);
    }

    // 每月 1 号静默刷新节假日数据（内部有节流；失败不做任何提示）。
    if jitter_core::holiday::refresh_if_monthly_due(now) {
        tokio::spawn(jitter_core::holiday::refresh_years_silent());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_id(label: &str) -> String {
        format!("scheduler-test-{label}-{}", std::process::id())
    }

    fn interval_input(seconds: i64) -> jitter_core::db::NewTaskInput {
        jitter_core::db::NewTaskInput {
            name: "scheduler lifecycle".to_string(),
            curl_command: Some("curl http://127.0.0.1:1".to_string()),
            request: jitter_core::db::RequestParts {
                url: "http://127.0.0.1:1".to_string(),
                method: "GET".to_string(),
                headers: Some("{}".to_string()),
                body: None,
                options: Some("{}".to_string()),
            },
            schedule_kind: Some("interval".to_string()),
            interval_seconds: Some(seconds),
            window_start: "10:10".to_string(),
            window_end: "10:20".to_string(),
            ..Default::default()
        }
    }

    fn init_interval_task(label: &str, seconds: i64) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("jitter-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("app.db");
        let mut config = jitter_core::config::AppConfig::default();
        config.db_path = path.to_string_lossy().to_string();
        jitter_core::config::set_active_config(config);
        jitter_core::db::init_db(Some(path.to_str().expect("path"))).expect("init db");
        let id = test_id(label);
        jitter_core::db::create_task(&interval_input(seconds), &id, 1000).expect("create task");
        (path, id)
    }

    fn cleanup_interval_task(path: &std::path::Path) {
        jitter_core::db::close_db();
        jitter_core::config::set_active_config(jitter_core::config::AppConfig::default());
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn a_timer_that_loses_the_run_slot_still_gets_a_future_plan() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let (path, id) = init_interval_task("timer-conflict", 60);
        let manual = begin_run(&id, CancellationToken::new()).expect("manual run holds the slot");
        let target = executor::now_ms();

        arm_timer(id.clone(), target);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let task = jitter_core::db::get_task(&id).expect("read task").expect("task");
                let timer_finished = state()
                    .lock()
                    .expect("state")
                    .timers
                    .get(&id)
                    .is_some_and(|timer| timer.handle.is_finished());
                if timer_finished || task.next_run_at.is_some_and(|next| next > target) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("timer must finish or replace its missed plan");

        sweep_once().await;
        let next = jitter_core::db::get_task(&id)
            .expect("read task")
            .expect("task")
            .next_run_at
            .expect("next plan");
        assert!(next > executor::now_ms(), "槽位冲突后不能留下已触发的死计划");

        drop(manual);
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        cleanup_interval_task(path.parent().expect("temp parent"));
    }

    #[tokio::test]
    async fn an_old_scheduled_run_cannot_overwrite_a_new_schedule() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let (path, id) = init_interval_task("stale-schedule", 60);
        let old_task = jitter_core::db::get_task(&id).expect("read task").expect("task");
        let old_spec = task_spec(&old_task).expect("old spec");
        schedule_new_task(&id);
        let old_target = jitter_core::db::get_task(&id)
            .expect("read task")
            .expect("task")
            .next_run_at
            .expect("old target");
        let old_generation = *state()
            .lock()
            .expect("state")
            .schedule_generations
            .get(&id)
            .expect("old schedule generation");

        jitter_core::db::update_task_config(&id, &interval_input(300), executor::now_ms())
            .expect("update schedule");
        schedule_new_task(&id);
        let new_target = jitter_core::db::get_task(&id)
            .expect("read task")
            .expect("task")
            .next_run_at
            .expect("new target");

        drop(ScheduleNextOnDrop {
            task: old_task,
            spec: old_spec,
            target: old_target,
            generation: old_generation,
        });

        let actual = jitter_core::db::get_task(&id)
            .expect("read task")
            .expect("task")
            .next_run_at
            .expect("next plan");
        assert_eq!(actual, new_target, "旧执行收尾不能覆盖用户刚保存的新计划");

        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        cleanup_interval_task(path.parent().expect("temp parent"));
    }

    #[tokio::test]
    async fn a_failed_restart_keeps_run_admission_closed() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        let (path, id) = init_interval_task("failed-restart", 60);
        jitter_core::db::close_db();
        let error = start().await.expect_err("closed database must fail restart");
        assert!(!error.to_string().is_empty());
        jitter_core::db::init_db(Some(path.to_str().expect("path"))).expect("reopen db");

        let admitted = begin_task_run(&id, CancellationToken::new(), RunAdmission::Manual);
        let admission_opened = admitted.is_some();
        drop(admitted);

        stop().await;
        cleanup_interval_task(&path);
        assert!(
            !admission_opened,
            "重启失败后不得提前打开手动执行准入门"
        );
        SWEEP_STOP.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn begin_run_reserves_the_slot_atomically() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("atomic");
        let first = begin_run(&id, CancellationToken::new()).expect("first run starts");
        assert!(running_tasks().contains_key(&id));

        assert!(
            begin_run(&id, CancellationToken::new()).is_none(),
            "第二个调用必须在检查的同一把锁里看到已预留的运行槽"
        );

        drop(first);
        assert!(!running_tasks().contains_key(&id));
    }

    #[tokio::test]
    async fn overlapping_lifecycle_transitions_keep_admission_blocked_until_both_finish() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let (path, id) = init_interval_task("overlapping-transitions", 60);

        block_task_runs(&id);
        block_task_runs(&id);
        finish_task_transition(&id);
        assert!(
            begin_task_run(&id, CancellationToken::new(), RunAdmission::Manual).is_none(),
            "另一个停止/删除转换仍可能写库时，准入门不能提前打开"
        );

        finish_task_transition(&id);
        let (run, _) = begin_task_run(&id, CancellationToken::new(), RunAdmission::Manual)
            .expect("all lifecycle transitions finished");
        drop(run);
        stop().await;
        cleanup_interval_task(&path);
    }

    #[tokio::test]
    async fn cancelling_future_schedule_does_not_cancel_the_current_request() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("stop");
        let run = begin_run(&id, CancellationToken::new()).expect("run starts");

        cancel_schedule(&id);

        assert!(running_tasks().contains_key(&id));
        assert!(!run.cancel.is_cancelled(), "停止任务不能中断当前请求");
        drop(run);
    }

    #[tokio::test]
    async fn deleting_a_task_cancels_the_current_request() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("delete");
        let run = begin_run(&id, CancellationToken::new()).expect("run starts");

        cancel_task(&id);

        assert!(run.cancel.is_cancelled());
        assert!(!running_tasks().contains_key(&id));
        drop(run);
        assert!(!running_tasks().contains_key(&id), "清理必须幂等");
    }

    #[tokio::test]
    async fn cancelling_and_restarting_a_task_keeps_the_new_run_slot() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("generation-guard");
        let first = begin_run(&id, CancellationToken::new()).expect("first run starts");

        cancel_task(&id);
        let second = begin_run(&id, CancellationToken::new()).expect("second run starts");

        drop(first);
        assert!(running_tasks().contains_key(&id), "旧 Guard 不能删掉新运行槽");
        assert!(!second.cancel.is_cancelled());
        drop(second);
        assert!(!running_tasks().contains_key(&id));
    }

    #[tokio::test]
    async fn a_stale_handle_is_not_attached_to_a_replacement_run() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("stale-handle");
        let first = begin_run(&id, CancellationToken::new()).expect("first run starts");
        cancel_task(&id);
        let second = begin_run(&id, CancellationToken::new()).expect("replacement starts");
        let handle = tokio::spawn(std::future::pending::<()>());

        attach_run_handle(&id, first.generation, handle);

        let attached = state()
            .lock()
            .expect("state")
            .running
            .get(&id)
            .and_then(|running| running.handle.as_ref())
            .is_some();
        assert!(!attached, "旧执行的句柄不能挂到新运行槽");
        assert!(!second.cancel.is_cancelled());
        drop(first);
        drop(second);
    }

    #[tokio::test]
    async fn idle_wait_does_not_finish_until_the_last_guard_is_released() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("idle-wait");
        let run = begin_run(&id, CancellationToken::new()).expect("run starts");
        let mut idle = Box::pin(wait_for_runs_idle());

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut idle)
                .await
                .is_err(),
            "还有 RunningGuard 时，停止流程不能提前返回"
        );
        drop(run);
        tokio::time::timeout(std::time::Duration::from_secs(1), idle)
            .await
            .expect("最后一个 Guard 释放后必须唤醒等待者");
    }

    #[tokio::test]
    async fn a_panicking_run_releases_its_slot() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        let id = test_id("panic");
        let task_id = id.clone();
        let handle = tokio::spawn(async move {
            let _run = begin_run(&task_id, CancellationToken::new()).expect("run starts");
            panic!("simulated executor panic");
        });

        assert!(handle.await.is_err());
        assert!(!running_tasks().contains_key(&id));
    }

    #[tokio::test]
    async fn stop_awaits_aborted_timers() {
        let _serial = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        use std::sync::Arc;
        use std::sync::atomic::AtomicBool;

        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        stop().await;
        let dropped = Arc::new(AtomicBool::new(false));
        let task_flag = Arc::clone(&dropped);
        let handle = tokio::spawn(async move {
            let _flag = DropFlag(task_flag);
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        state()
            .lock()
            .expect("state")
            .timers
            .insert(
                test_id("await-timer"),
                ScheduledTimer {
                    handle,
                    generation: 0,
                },
            );

        stop().await;

        assert!(dropped.load(Ordering::SeqCst), "停止流程必须等被 abort 的定时器真正退出");
        SWEEP_STOP.store(false, Ordering::SeqCst);
    }

    #[tokio::test(start_paused = true)]
    async fn restoring_the_scheduler_cancels_the_pending_startup_run() {
        let _config_lock = crate::api::tests::TEST_CONFIG_LOCK.lock().await;
        let dir = std::env::temp_dir().join(format!("jitter-startup-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("app.db");
        jitter_core::config::set_active_config(jitter_core::config::AppConfig::default());
        jitter_core::db::init_db(Some(path.to_str().expect("path"))).expect("db");
        let id = test_id("startup-cancel");
        let input = jitter_core::db::NewTaskInput {
            name: "startup".to_string(),
            curl_command: Some("curl http://127.0.0.1:1".to_string()),
            request: jitter_core::db::RequestParts {
                url: "http://127.0.0.1:1".to_string(),
                method: "GET".to_string(),
                headers: Some("{}".to_string()),
                body: None,
                options: Some("{}".to_string()),
            },
            window_start: "10:10".to_string(),
            window_end: "10:20".to_string(),
            run_on_startup: true,
            ..Default::default()
        };
        jitter_core::db::create_task(&input, &id, 1000).expect("create");
        let created = jitter_core::db::get_task(&id).expect("read").expect("exists");
        assert_eq!(created.run_on_startup, 1);
        assert_eq!(created.status, "active");
        let clock_guard = tokio::spawn(std::future::pending::<()>());

        spawn_startup_runs();
        tokio::task::yield_now().await;
        stop().await;
        start().await.expect("restart scheduler");
        assert!(!SWEEP_STOP.load(Ordering::SeqCst));
        tokio::time::advance(Duration::from_secs(16)).await;
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        let stale_run = running_tasks().contains_key(&id);
        let startup_logs = jitter_core::db::list_logs(&id, 100, None).expect("list startup logs");
        assert!(startup_logs.is_empty(), "恢复备份不能放行进程启动时遗留的自动执行记录");

        stop().await;
        SWEEP_STOP.store(false, Ordering::SeqCst);
        clock_guard.abort();
        jitter_core::db::close_db();
        jitter_core::config::set_active_config(jitter_core::config::AppConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!stale_run, "恢复备份不能放行进程启动时遗留的自动执行");
    }
}

//! 调度器：tokio 定时器驱动的每日窗口 / 循环执行。
//!
//! 语义复用已移植并通过测试的 schedule/window 模块：
//! 计划、恢复、迟到判定、暂停区间全部来自同一套核心。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use jitter_core::db::NewLogInput;
use jitter_core::executor;
use jitter_core::schedule::{self, StoredSchedule};
use jitter_core::window::PauseInterval;

struct Running {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
    /// 本次执行开始的时刻（ms），任务卡上的「执行中」徽标用它显示时长。
    started_at: i64,
}

struct SchedulerState {
    timers: HashMap<String, JoinHandle<()>>,
    running: HashMap<String, Running>,
}

static STATE: OnceLock<Mutex<SchedulerState>> = OnceLock::new();
static SWEEP_STOP: AtomicBool = AtomicBool::new(false);
static SWEEP_HANDLE: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static RUNNING_NOW: AtomicI64 = AtomicI64::new(0);

fn state() -> &'static Mutex<SchedulerState> {
    STATE.get_or_init(|| Mutex::new(SchedulerState {
        timers: HashMap::new(),
        running: HashMap::new(),
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
    SWEEP_STOP.store(false, Ordering::SeqCst);
    let tasks = jitter_core::db::list_tasks()?;
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
    tokio::spawn(async move {
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
            if !try_begin_run(&task.id) {
                continue;
            }
            tracing::info!("[scheduler] startup run {}", task.id);
            let cancel = CancellationToken::new();
            RUNNING_NOW.fetch_add(1, Ordering::SeqCst);
            let finish_id = task.id.clone();
            let registered_id = task.id.clone();
            let run_cancel = cancel.clone();
            let handle = tokio::spawn(async move {
                let _ = executor::execute_task_run(
                    &task,
                    &run_cancel,
                    jitter_core::types::RunSource::Startup,
                )
                .await;
                finish_run(&finish_id);
            });
            state().lock().expect("state").running.insert(
                registered_id,
                Running {
                    cancel,
                    handle,
                    started_at: executor::now_ms(),
                },
            );
            // 多任务错开半秒，避免开机瞬间同时发请求。
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
}

pub async fn stop() {
    SWEEP_STOP.store(true, Ordering::SeqCst);
    let mut guard = state().lock().expect("state");
    for (_, running) in guard.running.drain() {
        running.cancel.cancel();
        running.handle.abort();
    }
    for (_, timer) in guard.timers.drain() {
        timer.abort();
    }
    if let Some(handle) = SWEEP_HANDLE.lock().expect("sweep handle").take() {
        handle.abort();
    }
}

/// 为一个任务（重新）排下一次执行。
pub fn schedule_new_task(task_id: &str) {
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
    let delay = (resume_at - executor::now_ms()).max(0) as u64;
    let id = task_id.to_string();
    let resume_id = id.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        schedule_new_task(&resume_id);
    });
    let mut guard = state().lock().expect("state");
    if let Some(old) = guard.timers.insert(id.clone(), handle) {
        old.abort();
    }
}

pub fn cancel_task(task_id: &str) {
    let mut guard = state().lock().expect("state");
    if let Some(timer) = guard.timers.remove(task_id) {
        timer.abort();
    }
    if let Some(running) = guard.running.remove(task_id) {
        running.cancel.cancel();
        running.handle.abort();
    }
}

pub fn try_begin_run(task_id: &str) -> bool {
    let guard = state().lock().expect("state");
    if guard.running.contains_key(task_id) {
        return false;
    }
    true
}

pub fn register_running(task_id: &str, cancel: CancellationToken) {
    RUNNING_NOW.fetch_add(1, Ordering::SeqCst);
    // 运行句柄由 spawn 的返回值填充；这里只登记取消令牌。
    let mut guard = state().lock().expect("state");
    guard.running.insert(
        task_id.to_string(),
        Running {
            cancel,
            // 占位：真正的 JoinHandle 在 spawn 后由 finish 前补齐并不重要，
            // 取消令牌已注册，JoinHandle 的 abort 只影响极端场景。
            handle: tokio::spawn(async {}),
            started_at: executor::now_ms(),
        },
    );
}

/// 一次执行完成：只清理运行状态，**不**排下一次。
/// 定时触发的调用方负责用 schedule_next_after（跑完后的下一次，
/// daily 会排明天，不会在同一窗口内连环重跑）；手动执行不影响计划。
pub fn finish_run(task_id: &str) {
    RUNNING_NOW.fetch_sub(1, Ordering::SeqCst);
    let mut guard = state().lock().expect("state");
    guard.running.remove(task_id);
}

/// 正在执行的任务 → 开始时刻（ms）。
pub fn running_tasks() -> std::collections::HashMap<String, i64> {
    let guard = state().lock().expect("state");
    guard.running.iter().map(|(id, running)| (id.clone(), running.started_at)).collect()
}

pub fn running_count() -> i64 {
    RUNNING_NOW.load(Ordering::SeqCst)
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
    let delay = (target - executor::now_ms()).max(0) as u64;
    tracing::info!("[scheduler] arm {task_id}: target={target} delay={delay}ms");
    let fire_id = task_id.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        fire(fire_id, target).await;
    });
    let mut guard = state().lock().expect("state");
    if let Some(old) = guard.timers.insert(task_id.clone(), handle) {
        old.abort();
    }
    let _ = jitter_core::db::update_task_next_run(&task_id, Some(target), executor::now_ms());
}

async fn fire(task_id: String, target: i64) {
    tracing::info!("[scheduler] fire {task_id}: target={target}");
    let Ok(Some(task)) = jitter_core::db::get_task(&task_id) else {
        return;
    };
    if task.status != "active" {
        return;
    }
    let Some(spec) = task_spec(&task) else {
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
        schedule_next_after(&task, &spec, target);
        return;
    }

    if !try_begin_run(&task_id) {
        return;
    }
    tracing::info!("[scheduler] execute {task_id} (定时触发)");
    let cancel = CancellationToken::new();
    RUNNING_NOW.fetch_add(1, Ordering::SeqCst);
    let run_task_id = task_id.clone();
    let run_cancel = cancel.clone();
    let handle = tokio::spawn(async move {
        let _ = executor::execute_task_run(&task, &run_cancel, jitter_core::types::RunSource::Scheduled).await;
        finish_run(&run_task_id);
        // daily：本次窗口已用掉，排明天；interval：锚定到网格防漂移。
        schedule_next_after(&task, &spec, target);
    });
    {
        let mut guard = state().lock().expect("state");
        guard.running.insert(
            task_id,
            Running {
                cancel,
                handle,
                started_at: executor::now_ms(),
            },
        );
    }
}

/// 一次执行完成后的下一次计划（防漂移）。
fn schedule_next_after(task: &jitter_core::db::TaskRow, spec: &schedule::ScheduleSpec, fired_at: i64) {
    let now = executor::now_ms();
    let pause = match (task.paused_from, task.paused_until) {
        (Some(from), Some(until)) => Some(PauseInterval { from, until }),
        _ => None,
    };
    let target = match schedule::plan_schedule_after(now, spec, fired_at, pause, &mut rand()) {
        Ok(target) => target,
        Err(_) => return,
    };
    arm_timer(task.id.clone(), target);
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

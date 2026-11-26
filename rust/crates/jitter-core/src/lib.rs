//! Jitter 的核心逻辑：条件求值、窗口与计划、curl 解析、数据库与执行器。
//!
//! 这一层不依赖 HTTP 框架，可以单独测试。

pub mod backup;
pub mod condition;
pub mod config;
pub mod db;
pub mod executor;
pub mod guard;
pub mod holiday;
pub mod host;
pub mod instance;
pub mod logging;
pub mod metrics;
pub mod curl_parser;
pub mod probe;
pub mod schedule;
pub mod system;
pub mod testbench;
pub mod types;
pub mod updater;
pub mod window;

pub use condition::{evaluate_condition, validate_condition, ConditionContext, ConditionError};
pub use window::{
    classify_timer_fire, parse_window, pause_interval, plan_after_run_with_pause, plan_new_task,
    plan_next_window_after, plan_paused, plan_recovery, plan_resume_window, plan_with_pause,
    random_point, start_of_local_day, validate_window, window_instance_at, PauseInterval,
    RecoveryPlan, RecoveryReason, TimerFireVerdict, WindowError, WindowInstance, WindowSpec,
    INSTANT_GRACE_MS, MAX_PAUSE_DAYS,
};

/// The version of the application, injected at build time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

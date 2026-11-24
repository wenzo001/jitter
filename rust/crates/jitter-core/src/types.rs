//! 与 TypeScript 版 `src/types.ts` 对应的数据结构。
//!
//! 字段名与 JSON 输出保持一致（camelCase 的 `proxyAuthorization` 等），
//! 这样前端与存储层不需要任何改动。

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// 保持插入顺序的 JSON 对象（serde_json 的 preserve_order 特性）。
pub type JsonMap = serde_json::Map<String, Json>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RedirectMode {
    Follow,
    Manual,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insecure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect: Option<RedirectMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_authorization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestSpec {
    pub url: String,
    pub method: String,
    /// 保持插入顺序的 JSON 对象（与 JS 的 `Record<string, string>` 一致）。
    pub headers: JsonMap,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<RequestOptions>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Task,
    Notify,
    Missed,
    Skipped,
}

impl LogKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogKind::Task => "task",
            LogKind::Notify => "notify",
            LogKind::Missed => "missed",
            LogKind::Skipped => "skipped",
        }
    }
}

/// 一次执行的触发来源（写入 logs.run_source，页面据此区分手动/定时/开机）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSource {
    /// 定时器触发。
    Scheduled,
    /// 页面「立即执行」。
    Manual,
    /// Jitter 启动后按任务配置自动执行一次。
    Startup,
}

impl RunSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunSource::Scheduled => "scheduled",
            RunSource::Manual => "manual",
            RunSource::Startup => "startup",
        }
    }
}

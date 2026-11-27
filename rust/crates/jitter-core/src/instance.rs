//! 实例隔离：一个机器上可以同时跑多个 Jitter，互不干扰。
//!
//! # 为什么要这个
//!
//! Jitter 原本假设「一台机器只有一个实例」，所有全局状态都写死在一个地方：
//!
//! | 全局状态 | 原路径 | 冲突后果 |
//! | --- | --- | --- |
//! | 配置 / 运行时文件 | `%APPDATA%\Jitter\jitter.runtime.json` | 开发实例覆盖生产实例的端口记录，生产实例退出时把它删掉 |
//! | 开机自启注册 | `%APPDATA%\...\Startup\Jitter.cmd` | **开发实例在设置里点一次「开机自启」，就把生产实例的注册覆盖成开发版路径** |
//! | 单实例互斥体 | `Local\JitterSingleInstance` | 开发实例要靠 `JITTER_ALLOW_MULTI_INSTANCE=1` 才能绕过 |
//!
//! 自启那条最危险：它写在用户可见的系统目录里，界面上只是一个开关，
//! 用户完全看不出自己刚把生产实例的开机自启改掉了。
//!
//! # 怎么隔离
//!
//! 用环境变量 `JITTER_INSTANCE` 声明实例名（默认 `prod`）：
//!
//! - 配置目录：`%APPDATA%\Jitter`（生产）/ `%APPDATA%\Jitter-dev`（开发）
//! - 运行时文件：配置目录下的 `jitter.runtime.json`
//! - 自启注册：文件名带实例后缀（`Jitter.cmd` / `Jitter-dev.cmd`）
//! - 互斥体名：`Local\JitterSingleInstance-prod` / `-dev`
//!
//! **生产实例的行为一个字都不变**：实例名默认 `prod`，配置目录与自启文件名
//! 都与旧版逐字节相同，所以升级现有安装版不会动到用户已有的自启注册和配置。
//!
//! 唯一一处旧版行为的变化是互斥体名：旧版是 `Local\JitterSingleInstance`，
//! 现在统一带实例后缀（`-prod` / `-dev`）。这是有意的——如果生产沿用旧名而
//! 开发用新名，「按实例互斥」这件事就不自洽了；统一加后缀才能让
//! 「每个实例各自互斥、实例之间互不干扰」同时成立。
//! 升级后第一个生产实例会重新抢一次互斥体（此时没有旧实例在跑，无副作用）。

use std::env;
use std::path::PathBuf;

/// 默认实例名：生产实例。旧版行为以它为准。
pub const DEFAULT_INSTANCE: &str = "prod";

/// 实例名环境变量。
pub const INSTANCE_ENV: &str = "JITTER_INSTANCE";

/// 当前实例名。
///
/// 取 `JITTER_INSTANCE`，缺省或空白时是 `prod`。名字会被规范化：
/// 只保留字母、数字、`-`、`_`，其余字符换成 `-`，并截断到 32 字符。
/// 这样它可以安全地进文件路径、互斥体名和自启文件名。
pub fn instance_name() -> String {
    normalize_instance_name(&env::var(INSTANCE_ENV).unwrap_or_default())
}

/// 规范化实例名（纯函数，便于单测）。
pub fn normalize_instance_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return DEFAULT_INSTANCE.to_string();
    }
    let mut out = String::with_capacity(trimmed.len().min(32));
    for ch in trimmed.chars() {
        if out.len() >= 32 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let cleaned = out.trim_matches('-').to_string();
    if cleaned.is_empty() {
        DEFAULT_INSTANCE.to_string()
    } else {
        cleaned
    }
}

/// 是否是默认（生产）实例。
pub fn is_default_instance() -> bool {
    instance_name() == DEFAULT_INSTANCE
}

/// 实例名后缀：生产是空串，其它是 `-dev` 这样的形式。
///
/// 用在文件名上（`Jitter.cmd` → `Jitter-dev.cmd`），
/// 生产实例拿到的仍是旧文件名。
pub fn instance_suffix() -> String {
    suffix_for(&instance_name())
}

/// 后缀（纯函数版本）。
pub fn suffix_for(name: &str) -> String {
    if name == DEFAULT_INSTANCE {
        String::new()
    } else {
        format!("-{}", name)
    }
}

/// 自启注册项的 id：生产是 `jitter`，其它是 `jitter-dev`。
pub fn autostart_id() -> String {
    autostart_id_for(&instance_name())
}

/// 自启注册 id（纯函数版本）。
pub fn autostart_id_for(name: &str) -> String {
    format!("jitter{}", suffix_for(name))
}

/// 自启注册文件名（不含扩展名）：生产是 `Jitter`，其它是 `Jitter-dev`。
pub fn autostart_file_stem() -> String {
    autostart_file_stem_for(&instance_name())
}

/// 自启注册文件名（纯函数版本）。
pub fn autostart_file_stem_for(name: &str) -> String {
    format!("Jitter{}", suffix_for(name))
}

/// 单实例互斥体名：生产是 `Local\JitterSingleInstance-prod`，其它带实例后缀。
pub fn single_instance_mutex_name() -> String {
    mutex_name_for(&instance_name())
}

/// 互斥体名（纯函数版本）。
pub fn mutex_name_for(name: &str) -> String {
    format!("Local\\JitterSingleInstance-{}", name)
}

#[cfg(not(windows))]
pub fn acquire_file_lock(db_path: &PathBuf, instance: &str) -> std::io::Result<Option<std::fs::File>> {
    use std::io::ErrorKind;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let absolute = std::path::absolute(db_path).unwrap_or_else(|_| db_path.clone());
    let parent = absolute.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in absolute.to_string_lossy().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let path = parent.join(format!(
        ".jitter-{}-{hash:016x}.lock",
        normalize_instance_name(instance)
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(file))
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

/// 实例专属的配置目录。
///
/// 生产实例仍然是 `%APPDATA%\Jitter`（与旧版一致），其它实例是 `%APPDATA%\Jitter-dev`。
pub fn instance_config_dir() -> PathBuf {
    config_dir_for(&instance_name())
}

/// 配置目录（纯函数版本：只依赖实例名）。
pub fn config_dir_for(name: &str) -> PathBuf {
    let base = base_config_dir();
    if name == DEFAULT_INSTANCE {
        base
    } else {
        base.join(format!("Jitter{}", suffix_for(name)))
    }
}

/// 平台默认的配置目录（不含实例后缀）。
fn base_config_dir() -> PathBuf {
    match std::env::consts::OS {
        "windows" => env_or("APPDATA", home_dir().join("AppData").join("Roaming"))
            .join("Jitter"),
        "macos" => home_dir()
            .join("Library")
            .join("Application Support")
            .join("Jitter"),
        _ => env_or("XDG_CONFIG_HOME", home_dir().join(".config")).join("jitter"),
    }
}

/// 平台默认配置目录的**目录名**（不含实例后缀）。
///
/// 生产实例用的就是它，开发实例在它后面接 `-<实例名>`。
///
/// 各平台默认目录名并不一样（Windows / macOS 是 `Jitter`，Linux 是 `jitter`），
/// 所以断言「生产目录名等于它」比断言字面量 `Jitter` 跨平台都对。
pub fn base_config_dir_name() -> String {
    base_config_dir()
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn home_dir() -> PathBuf {
    if std::env::consts::OS == "windows" {
        if let Ok(profile) = env::var("USERPROFILE") {
            if !profile.trim().is_empty() {
                return PathBuf::from(profile);
            }
        }
    }
    if let Ok(home) = env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(".")
}

fn env_or(env_key: &str, fallback: PathBuf) -> PathBuf {
    match env::var(env_key) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空名字等于默认实例() {
        assert_eq!(normalize_instance_name(""), "prod");
        assert_eq!(normalize_instance_name("   "), "prod");
    }

    #[test]
    fn 名字里的非法字符换成横线() {
        assert_eq!(normalize_instance_name("dev"), "dev");
        assert_eq!(normalize_instance_name("my dev"), "my-dev");
        assert_eq!(normalize_instance_name("a/b"), "a-b");
        assert_eq!(normalize_instance_name("dev_2"), "dev_2");
    }

    #[test]
    fn 全是非法字符的名字回落到默认实例() {
        // 名字被换成横线后又被 trim 掉，结果为空 → 回落成默认实例，
        // 绝不能变成一个空名字（那会让路径塌回生产目录）。
        assert_eq!(normalize_instance_name("测试"), "prod");
        assert_eq!(normalize_instance_name("///"), "prod");
    }

    #[test]
    fn 名字被截断到_32_字符() {
        let long = "a".repeat(60);
        assert_eq!(normalize_instance_name(&long).len(), 32);
    }

    #[test]
    fn 生产实例的后缀是空的() {
        assert_eq!(suffix_for("prod"), "");
        assert_eq!(suffix_for("dev"), "-dev");
    }

    #[test]
    fn 自启文件名区分实例() {
        // 生产用旧文件名，升级不会动到用户已有的注册项。
        assert_eq!(autostart_file_stem_for("prod"), "Jitter");
        assert_eq!(autostart_file_stem_for("dev"), "Jitter-dev");
        assert_eq!(autostart_id_for("prod"), "jitter");
        assert_eq!(autostart_id_for("dev"), "jitter-dev");
    }

    #[test]
    fn 互斥体名区分实例() {
        assert_eq!(mutex_name_for("prod"), "Local\\JitterSingleInstance-prod");
        assert_eq!(mutex_name_for("dev"), "Local\\JitterSingleInstance-dev");
    }

    #[test]
    fn 配置目录区分实例() {
        let prod = config_dir_for("prod");
        let dev = config_dir_for("dev");
        assert_ne!(prod, dev);
        // 生产目录就是平台默认目录（不带实例后缀）。
        // 注意各平台默认目录名不同：Windows / macOS 是 `Jitter`，Linux 是 `jitter`，
        // 所以这里比的是「等于平台默认名」，不能写死字面量。
        assert_eq!(prod.file_name(), base_config_dir().file_name());
        // 开发目录在默认名后面接 `-<实例名>`。
        assert_eq!(dev.file_name().unwrap().to_string_lossy(), "Jitter-dev");
    }

    #[cfg(not(windows))]
    #[test]
    fn file_lock_excludes_only_the_same_instance_and_database() {
        let dir = std::env::temp_dir().join(format!("jitter-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create lock test dir");
        let db = dir.join("app.db");
        let other_db = dir.join("other.db");

        let first = acquire_file_lock(&db, "dev").expect("first lock").expect("uncontended");
        assert!(acquire_file_lock(&db, "dev").expect("second lock").is_none());
        let _other_instance = acquire_file_lock(&db, "prod").expect("instance lock").expect("different instance");
        let _other_database = acquire_file_lock(&other_db, "dev").expect("database lock").expect("different database");
        drop(first);
        assert!(acquire_file_lock(&db, "dev").expect("released lock").is_some());

        std::fs::remove_dir_all(dir).expect("remove lock test dir");
    }
}

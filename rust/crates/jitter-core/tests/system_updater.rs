use jitter_core::instance;
use jitter_core::system;
use jitter_core::updater;

/// 纯路径构造测试：Windows 上 Path 用 `\`，归一化后比较 POSIX 形式。
fn posix(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[test]
fn windows_autostart_entry_writes_startup_cmd() {
    let entry = system::build_autostart_entry(
        "win32",
        r"C:\Apps\Jitter\jitter.exe",
        r"C:\Users\tester",
        Some(r"C:\Users\tester\AppData\Roaming"),
        None,
    );
    assert!(posix(&entry.path)
        .contains("Microsoft/Windows/Start Menu/Programs/Startup/Jitter.cmd"));
    assert!(entry.content.contains("@echo off"));
    // 中文系统控制台默认 GBK：先切 UTF-8，否则中文路径解析失败。
    assert!(entry.content.contains("chcp 65001 >nul"));
    // 开机时盘符可能未就绪：先等文件出现，再 start；找不到就安静退出。
    assert!(entry.content.contains(r#"set "exe=C:\Apps\Jitter\jitter.exe""#));
    assert!(entry.content.contains(r#"if exist "%exe%" goto run"#));
    assert!(entry.content.contains(r#"exit /b 0"#));
    assert!(entry
        .content
        .contains(r#"start "" /D "C:\Apps\Jitter" "%exe%" --background"#));
}

#[test]
fn windows_autostart_entry_falls_back_to_home() {
    let entry = system::build_autostart_entry("win32", "/usr/bin/jitter", r"C:\Users\tester", None, None);
    assert!(posix(&entry.path)
        .contains("C:/Users/tester/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/Jitter.cmd"));
}

#[test]
fn macos_autostart_entry_writes_launchagent_plist() {
    let entry = system::build_autostart_entry("darwin", "/Applications/Jitter.app/jitter", "/Users/tester", None, None);
    assert!(posix(&entry.path).contains("/Users/tester/Library/LaunchAgents/com.jitter.app.plist"));
    assert!(entry.content.contains("<string>com.jitter.app</string>"));
    assert!(entry
        .content
        .contains("<string>/Applications/Jitter.app/jitter</string>"));
    assert!(entry.content.contains("<string>--background</string>"));
    assert!(entry.content.contains("<key>WorkingDirectory</key>"));
    assert!(entry.content.contains("<string>/Applications/Jitter.app</string>"));
    assert!(entry.content.contains("<key>RunAtLoad</key>"));
}

#[test]
fn linux_autostart_entry_writes_desktop_file() {
    let entry = system::build_autostart_entry("linux", "/opt/jitter/jitter", "/home/tester", None, None);
    assert!(posix(&entry.path).contains("/home/tester/.config/autostart/jitter.desktop"));
    assert!(entry.content.contains("Name=Jitter"));
    assert!(entry
        .content
        .contains("Exec=\"/opt/jitter/jitter\" --background"));
    assert!(entry.content.contains("Path=/opt/jitter"));
    assert!(entry.content.contains("Terminal=false"));
}

#[test]
fn linux_autostart_entry_respects_xdg_config_home() {
    let entry = system::build_autostart_entry("linux", "/opt/jitter/jitter", "/home/tester", None, Some("/custom/config"));
    assert!(posix(&entry.path).starts_with("/custom/config/autostart/"));
}

/// **实例隔离的核心保证**：不同实例注册**不同的自启文件**。
///
/// 这条曾经是个真坑：开发实例在设置里点一次「开机自启」，
/// 就会把生产实例的 `Jitter.cmd` 覆盖成开发版的路径——
/// 用户界面上只看到一个开关，完全看不出自己改了什么。
#[test]
fn autostart_entries_are_isolated_per_instance() {
    let prod = system::build_autostart_entry_for(
        "win32",
        r"C:\Apps\Jitter\jitter.exe",
        r"C:\Users\tester",
        Some(r"C:\Users\tester\AppData\Roaming"),
        None,
        "prod",
    );
    let dev = system::build_autostart_entry_for(
        "win32",
        r"D:\repo\rust\target\release\jitter.exe",
        r"C:\Users\tester",
        Some(r"C:\Users\tester\AppData\Roaming"),
        None,
        "dev",
    );

    assert!(posix(&prod.path).ends_with("Startup/Jitter.cmd"));
    assert!(posix(&dev.path).ends_with("Startup/Jitter-dev.cmd"));
    assert_ne!(prod.path, dev.path, "两个实例不能共用同一个自启文件");

    // 各自指向自己的 exe。
    assert!(prod.content.contains(r#"set "exe=C:\Apps\Jitter\jitter.exe""#));
    assert!(dev.content.contains(r#"set "exe=D:\repo\rust\target\release\jitter.exe""#));

    // macOS / Linux 同理。
    let mac_prod = system::build_autostart_entry_for("darwin", "/a/jitter", "/Users/t", None, None, "prod");
    let mac_dev = system::build_autostart_entry_for("darwin", "/b/jitter", "/Users/t", None, None, "dev");
    assert!(posix(&mac_prod.path).ends_with("com.jitter.app.plist"));
    assert!(posix(&mac_dev.path).ends_with("com.jitter-dev.app.plist"));

    let linux_prod = system::build_autostart_entry_for("linux", "/a/jitter", "/home/t", None, None, "prod");
    let linux_dev = system::build_autostart_entry_for("linux", "/b/jitter", "/home/t", None, None, "dev");
    assert!(posix(&linux_prod.path).ends_with("jitter.desktop"));
    assert!(posix(&linux_dev.path).ends_with("jitter-dev.desktop"));
}

/// 生产实例的路径必须与旧版逐字节相同：升级不能动到用户已有的配置与自启。
#[test]
fn production_instance_paths_match_the_legacy_layout() {
    // 自启文件名没变。
    let entry = system::build_autostart_entry("win32", r"C:\Apps\Jitter\jitter.exe", r"C:\Users\tester", Some(r"C:\Users\tester\AppData\Roaming"), None);
    assert!(posix(&entry.path).ends_with("Startup/Jitter.cmd"));

    // 配置目录没变（生产仍是平台默认目录，不是 Jitter-prod）。
    // 各平台默认目录名不同（Windows / macOS 是 `Jitter`，Linux 是 `jitter`），
    // 所以比的是「等于平台默认名」，不能写死字面量 `Jitter`。
    let prod_dir = instance::config_dir_for("prod");
    assert_eq!(
        prod_dir.file_name().unwrap().to_string_lossy(),
        instance::base_config_dir_name(),
        "生产实例的配置目录名不能变"
    );

    // 开发实例则是独立的子目录。
    let dev_dir = instance::config_dir_for("dev");
    assert_eq!(dev_dir.file_name().unwrap().to_string_lossy(), "Jitter-dev");
    assert_ne!(prod_dir, dev_dir);
}

/// 互斥体名按实例区分：不同实例互不阻塞，同一实例仍然只允许一个。
#[test]
fn mutex_names_are_isolated_per_instance() {
    assert_eq!(
        instance::mutex_name_for("prod"),
        "Local\\JitterSingleInstance-prod"
    );
    assert_eq!(
        instance::mutex_name_for("dev"),
        "Local\\JitterSingleInstance-dev"
    );
    assert_ne!(
        instance::mutex_name_for("prod"),
        instance::mutex_name_for("dev")
    );
}

#[test]
fn asset_name_matches_updater_contract() {
    let name = updater::asset_name();
    let valid = ["jitter-windows-x64.zip", "jitter-macos-arm64.zip", "jitter-macos-x64.zip", "jitter-linux-x64.zip", "jitter-linux-arm64.zip"];
    assert!(valid.contains(&name.as_str()), "意外的资产名 {name}");
}

#[test]
fn compares_versions_with_semver_prerelease_rules() {
    assert_eq!(updater::compare_versions("1.2.3", "1.2.3"), 0);
    assert_eq!(updater::compare_versions("v1.2.3", "1.2.3"), 0);
    assert_eq!(updater::compare_versions("1.2.4", "1.2.3"), 1);
    assert_eq!(updater::compare_versions("1.2.3", "1.2.4"), -1);
    assert_eq!(updater::compare_versions("1.10.0", "1.9.0"), 1);
    assert_eq!(updater::compare_versions("2.0.0", "1.99.99"), 1);
    // 正式版比同版本的预发布版新。
    assert_eq!(updater::compare_versions("1.2.3", "1.2.3-beta"), 1);
    assert_eq!(updater::compare_versions("1.2.3-beta", "1.2.3"), -1);
    assert_eq!(updater::compare_versions("1.2.3-beta", "1.2.3-alpha"), 1);
    // 宽松解析：缺位按 0 处理。
    assert_eq!(updater::compare_versions("1.2", "1.2.0"), 0);
}

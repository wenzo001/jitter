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

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

// ---------------------------------------------------------------------------
// 下载 / 校验 / 解压安全
// ---------------------------------------------------------------------------

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

static FIXTURE_SEQ: AtomicU32 = AtomicU32::new(0);

/// 本地 HTTP fixture：绝不访问真实第三方站点。
/// 每个路由 (path, body, send_content_length)。请求处理完即关闭连接。
fn spawn_http_fixture(routes: Vec<(String, Vec<u8>, bool)>) -> (String, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let port = listener.local_addr().expect("fixture port").port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop_thread.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 2048];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            let path = request
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            let response = match routes.iter().find(|(p, _, _)| *p == path) {
                Some((_, body, with_len)) => {
                    let head = if *with_len {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    } else {
                        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
                    };
                    let mut out = head.into_bytes();
                    out.extend_from_slice(body);
                    out
                }
                None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec(),
            };
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
    });
    (format!("http://127.0.0.1:{port}"), stop)
}

fn spawn_chunked_http_fixture(routes: Vec<(String, Vec<Vec<u8>>)>) -> (String, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind chunked fixture");
    let port = listener.local_addr().expect("fixture port").port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop_thread.load(Ordering::SeqCst) {
                break;
            }
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 2048];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]).to_string();
            let path = request
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            let mut response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
            if let Some((_, chunks)) = routes.iter().find(|(route, _)| *route == path) {
                for chunk in chunks {
                    response.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                    response.extend_from_slice(chunk);
                    response.extend_from_slice(b"\r\n");
                }
                response.extend_from_slice(b"0\r\n\r\n");
            }
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
    });
    (format!("http://127.0.0.1:{port}"), stop)
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "jitter-updater-{tag}-{}-{}",
        std::process::id(),
        FIXTURE_SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// 在内存里构造 zip：成员名精确按传入字符串写入（Stored，无需压缩特性）。
fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = {
        let buf = std::io::Cursor::new(Vec::new());
        zip::ZipWriter::new(buf)
    };
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    for (name, data) in entries {
        writer.start_file(*name, options).expect("start zip file");
        writer.write_all(data).expect("write zip entry");
    }
    let cursor = writer.finish().expect("finish zip");
    cursor.into_inner()
}

#[test]
fn sha256_matches_known_vectors() {
    assert_eq!(
        updater::sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        updater::sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // 跨过单块（64B）与多块边界（向量经 certutil SHA256 独立核对）。
    let long = vec![b'a'; 1000];
    assert_eq!(
        updater::sha256_hex(&long),
        "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
    // 多块 + padding 边界（total % 64 = 55 / 56 两条补充分支）。
    assert_eq!(
        updater::sha256_hex(&vec![b'z'; 55]),
        "5a383411d906da80612f366cb9b90ae54bcf6e7743b4117ace0884d98cd159ca"
    );
    assert_eq!(
        updater::sha256_hex(&vec![b'z'; 56]),
        "c66a5b692b9a20229733ef8b87cfec52679c86a0c0245643484c46d4dcd82afa"
    );

    let dir = temp_dir("sha");
    let path = dir.join("payload.bin");
    std::fs::write(&path, b"abc").unwrap();
    assert_eq!(
        updater::sha256_hex_file(&path).expect("hash file"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn parses_release_sha256_asset_content() {
    let hex = "a".repeat(64);
    assert_eq!(updater::parse_sha256_asset(hex.as_bytes()).as_deref(), Some(hex.as_str()));
    // GitHub Actions 产物格式："<hash>  <file>"，允许大写 / 换行。
    assert_eq!(
        updater::parse_sha256_asset(format!("{}  jitter-windows-x64.zip\r\n", hex.to_uppercase()).as_bytes()).as_deref(),
        Some(hex.as_str())
    );
    assert_eq!(updater::parse_sha256_asset(b"not-a-digest jitter.zip"), None);
    assert_eq!(updater::parse_sha256_asset(hex[..63].as_bytes()), None);
    assert_eq!(updater::parse_sha256_asset(b""), None);
}

#[test]
fn extract_binary_requires_exact_member_name() {
    let dir = temp_dir("extract");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();

    // 精确成员名：通过。
    let zip_bytes = build_zip(&[("jitter.exe", b"NEW-BINARY".as_slice())]);
    let zip_path = dir.join("good.zip");
    std::fs::write(&zip_path, &zip_bytes).unwrap();
    let binary = updater::extract_binary_from_zip(&zip_path, &work, "jitter.exe").expect("extract");
    assert_eq!(std::fs::read(&binary).unwrap(), b"NEW-BINARY");
    assert_eq!(binary.file_name().unwrap().to_string_lossy(), "jitter.exe");

    // suffix 陷阱：eviljitter.exe 以 jitter.exe 结尾但不是目标文件，必须拒绝。
    let zip_path = dir.join("suffix.zip");
    std::fs::write(&zip_path, build_zip(&[("eviljitter.exe", b"PAYLOAD".as_slice())])).unwrap();
    assert!(updater::extract_binary_from_zip(&zip_path, &work, "jitter.exe").is_err());

    // 嵌套同名：dir/jitter.exe 不是精确成员名，必须拒绝。
    let zip_path = dir.join("nested.zip");
    std::fs::write(&zip_path, build_zip(&[("pkg/jitter.exe", b"PAYLOAD".as_slice())])).unwrap();
    assert!(updater::extract_binary_from_zip(&zip_path, &work, "jitter.exe").is_err());

    // 错误架构（目标名不符）：Linux 包里的 jitter 不能当 windows 的 jitter.exe 用，反之亦然。
    let zip_path = dir.join("arch.zip");
    std::fs::write(&zip_path, build_zip(&[("jitter.exe", b"PAYLOAD".as_slice())])).unwrap();
    assert!(updater::extract_binary_from_zip(&zip_path, &work, "jitter").is_err());

    // 多匹配：同名成员出现两次必须拒绝（ZipWriter 禁止重名，手搓合法 zip 字节覆盖该分支）。
    let zip_path = dir.join("dup.zip");
    std::fs::write(
        &zip_path,
        build_zip_with_duplicate_entries("jitter.exe", b"A", b"B"),
    )
    .unwrap();
    assert!(updater::extract_binary_from_zip(&zip_path, &work, "jitter.exe").is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

/// 手工构造含两个同名 Stored 成员的 zip（zip  crate 写端拒绝重复名，只能按格式拼字节）。
fn build_zip_with_duplicate_entries(name: &str, payload_a: &[u8], payload_b: &[u8]) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let mut local = Vec::new();
    let mut central = Vec::new();
    let mut offsets = Vec::new();
    for payload in [payload_a, payload_b] {
        offsets.push(local.len() as u32);
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // stored
        local.extend_from_slice(&0u16.to_le_bytes()); // time
        local.extend_from_slice(&0u16.to_le_bytes()); // date
        local.extend_from_slice(&0u32.to_le_bytes()); // crc（读端默认不校验）
        local.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        local.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra len
        local.extend_from_slice(name_bytes);
        local.extend_from_slice(payload);

        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method
        central.extend_from_slice(&0u16.to_le_bytes()); // time
        central.extend_from_slice(&0u16.to_le_bytes()); // date
        central.extend_from_slice(&0u32.to_le_bytes()); // crc
        central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs：普通文件
        central.extend_from_slice(&offsets[offsets.len() - 1].to_le_bytes()); // local header offset
    }
    let mut out = local;
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn build_zip_with_forged_uncompressed_size(name: &str, output_len: u64, declared_len: u32) -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(name, options).expect("start zip file");
    std::io::copy(&mut std::io::repeat(0).take(output_len), &mut writer)
        .expect("write compressed payload");
    let mut bytes = writer.finish().expect("finish zip").into_inner();

    // 读端不要求本地头与中央目录的声明大小一致。
    let local_size_offset = bytes
        .windows(4)
        .position(|window| window == 0x04034b50u32.to_le_bytes())
        .expect("local header") + 22;
    bytes[local_size_offset..local_size_offset + 4]
        .copy_from_slice(&declared_len.to_le_bytes());
    let mut offset = 0;
    while let Some(relative) = bytes[offset..]
        .windows(4)
        .position(|window| window == 0x02014b50u32.to_le_bytes())
    {
        let central_size_offset = offset + relative + 24;
        bytes[central_size_offset..central_size_offset + 4]
            .copy_from_slice(&declared_len.to_le_bytes());
        offset = central_size_offset + 4;
    }
    bytes
}

#[test]
fn extract_binary_rejects_output_beyond_the_actual_byte_limit() {
    const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
    let dir = temp_dir("extract-actual-cap");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let zip_path = dir.join("forged-size.zip");
    std::fs::write(
        &zip_path,
        build_zip_with_forged_uncompressed_size(
            "jitter.exe",
            MAX_BINARY_BYTES + 1,
            1,
        ),
    )
    .unwrap();

    let error = updater::extract_binary_from_zip(&zip_path, &work, "jitter.exe")
        .expect_err("实际输出超过上限必须拒绝");
    assert!(error.contains("上限"), "应报真实输出超限: {error}");
    assert!(!work.join("jitter.exe").exists(), "超限后必须清理半截文件");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn streamed_download_enforces_size_cap() {
    let big_body = vec![7u8; 5000];

    // 带 Content-Length：超限应在读体前就拒绝。
    let (base, stop) = spawn_http_fixture(vec![("/pkg.zip".to_string(), big_body.clone(), true)]);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let dir = temp_dir("cap-len");
    let dest = dir.join("pkg.zip");
    let response = client.get(format!("{base}/pkg.zip")).send().await.unwrap();
    let error = updater::stream_response_to_file(response, &dest, 1000)
        .await
        .expect_err("超过上限必须失败");
    assert!(error.contains("上限"), "报错应说明超过上限: {error}");
    assert!(!dest.exists(), "超限下载不能留下文件");
    stop.store(true, Ordering::SeqCst);

    // 无 Content-Length（连接关闭分帧）：边流边计数，超限中止并清理半截文件。
    let (base, stop) = spawn_http_fixture(vec![("/pkg.zip".to_string(), big_body, false)]);
    let response = client.get(format!("{base}/pkg.zip")).send().await.unwrap();
    let dest2 = dir.join("stream.zip");
    let error = updater::stream_response_to_file(response, &dest2, 1000)
        .await
        .expect_err("无长度头时也必须封顶");
    assert!(error.contains("上限"), "报错应说明超过上限: {error}");
    assert!(!dest2.exists(), "超限中止后不能留下半截文件");
    stop.store(true, Ordering::SeqCst);

    // 上限内：完整落盘。
    let (base, _stop) = spawn_http_fixture(vec![("/ok.zip".to_string(), vec![9u8; 300], true)]);
    let response = client.get(format!("{base}/ok.zip")).send().await.unwrap();
    let dest3 = dir.join("ok.zip");
    updater::stream_response_to_file(response, &dest3, 1000)
        .await
        .expect("小于上限应成功");
    assert_eq!(std::fs::read(&dest3).unwrap(), vec![9u8; 300]);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_happy_path_verifies_and_extracts() {
    let zip_bytes = build_zip(&[("jitter.exe", b"NEW-BINARY".as_slice())]);
    let digest = updater::sha256_hex(&zip_bytes);
    let (base, stop) = spawn_http_fixture(vec![
        ("/jitter-win.zip".to_string(), zip_bytes.clone(), true),
        (
            "/jitter-win.zip.sha256".to_string(),
            format!("{digest}  jitter-win.zip\n").into_bytes(),
            true,
        ),
    ]);
    let dir = temp_dir("fetch-ok");
    let result = updater::fetch_update_package(
        &format!("{base}/jitter-win.zip"),
        Some(&format!("{base}/jitter-win.zip.sha256")),
        &dir,
        "jitter-win.zip",
        "jitter.exe",
        64 * 1024 * 1024,
        false,
    )
    .await;
    stop.store(true, Ordering::SeqCst);
    let binary = result.expect("合法包应成功");
    assert_eq!(std::fs::read(&binary).unwrap(), b"NEW-BINARY");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_rejects_checksum_asset_larger_than_limit_across_chunks() {
    let zip_bytes = build_zip(&[("jitter.exe", b"PAYLOAD".as_slice())]);
    let digest = updater::sha256_hex(&zip_bytes);
    let (zip_base, stop_zip) = spawn_http_fixture(vec![(
        "/jitter-win.zip".to_string(),
        zip_bytes,
        true,
    )]);
    let (sha_base, stop_sha) = spawn_chunked_http_fixture(vec![(
        "/jitter-win.zip.sha256".to_string(),
        vec![
            format!("{digest}  jitter-win.zip\n").into_bytes(),
            vec![b'x'; 300],
        ],
    )]);
    let dir = temp_dir("fetch-sha-chunks");
    let result = updater::fetch_update_package(
        &format!("{zip_base}/jitter-win.zip"),
        Some(&format!("{sha_base}/jitter-win.zip.sha256")),
        &dir,
        "jitter-win.zip",
        "jitter.exe",
        64 * 1024 * 1024,
        false,
    )
    .await;
    stop_zip.store(true, Ordering::SeqCst);
    stop_sha.store(true, Ordering::SeqCst);
    let error = result.expect_err("跨块超过 256 字节必须拒绝");
    assert!(error.contains("256"), "应报校验文件超限: {error}");
    assert!(!dir.join("jitter.exe").exists(), "超限校验文件不得触发解压");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_rejects_tampered_checksum() {
    let zip_bytes = build_zip(&[("jitter.exe", b"TAMPERED-PAYLOAD".as_slice())]);
    // 发布的 .sha256 对应的是另一份内容（伪造/篡改场景）。
    let wrong_digest = updater::sha256_hex(b"some other release");
    let (base, stop) = spawn_http_fixture(vec![
        ("/jitter-win.zip".to_string(), zip_bytes, true),
        (
            "/jitter-win.zip.sha256".to_string(),
            format!("{wrong_digest}  jitter-win.zip\n").into_bytes(),
            true,
        ),
    ]);
    let dir = temp_dir("fetch-tamper");
    let result = updater::fetch_update_package(
        &format!("{base}/jitter-win.zip"),
        Some(&format!("{base}/jitter-win.zip.sha256")),
        &dir,
        "jitter-win.zip",
        "jitter.exe",
        64 * 1024 * 1024,
        false,
    )
    .await;
    stop.store(true, Ordering::SeqCst);
    let error = result.expect_err("校验失败必须拒绝");
    assert!(error.contains("校验"), "报错应指明校验失败: {error}");
    assert!(!dir.join("jitter.exe").exists(), "校验失败不得解压安装");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_requires_checksum_asset() {
    let zip_bytes = build_zip(&[("jitter.exe", b"PAYLOAD".as_slice())]);
    let (base, stop) = spawn_http_fixture(vec![(
        "/jitter-win.zip".to_string(),
        zip_bytes,
        true,
    )]);
    let dir = temp_dir("fetch-nosha");
    let result = updater::fetch_update_package(
        &format!("{base}/jitter-win.zip"),
        None,
        &dir,
        "jitter-win.zip",
        "jitter.exe",
        64 * 1024 * 1024,
        false,
    )
    .await;
    stop.store(true, Ordering::SeqCst);
    assert!(result.expect_err("缺少 .sha256 必须拒绝").contains("校验"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_rejects_oversized_package() {
    let zip_bytes = vec![3u8; 5000];
    let digest = updater::sha256_hex(&zip_bytes);
    let (base, stop) = spawn_http_fixture(vec![
        ("/big.zip".to_string(), zip_bytes, true),
        (
            "/big.zip.sha256".to_string(),
            format!("{digest}  big.zip\n").into_bytes(),
            true,
        ),
    ]);
    let dir = temp_dir("fetch-oversize");
    let result = updater::fetch_update_package(
        &format!("{base}/big.zip"),
        Some(&format!("{base}/big.zip.sha256")),
        &dir,
        "big.zip",
        "jitter.exe",
        1000,
        false,
    )
    .await;
    stop.store(true, Ordering::SeqCst);
    let error = result.expect_err("超限包必须拒绝");
    assert!(error.contains("上限"), "报错应指明超过上限: {error}");
    assert!(!dir.join("jitter.exe").exists(), "超限包不得解压");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fetch_update_package_rejects_wrong_architecture_members() {
    // 包内只有嵌套的 pkg/jitter 与错误平台名 jitter.exe，没有精确的 jitter。
    let zip_bytes = build_zip(&[
        ("pkg/jitter", b"NESTED".as_slice()),
        ("jitter.exe", b"WINDOWS-BINARY".as_slice()),
    ]);
    let digest = updater::sha256_hex(&zip_bytes);
    let (base, stop) = spawn_http_fixture(vec![
        ("/linux.zip".to_string(), zip_bytes, true),
        (
            "/linux.zip.sha256".to_string(),
            format!("{digest}  linux.zip\n").into_bytes(),
            true,
        ),
    ]);
    let dir = temp_dir("fetch-arch");
    let result = updater::fetch_update_package(
        &format!("{base}/linux.zip"),
        Some(&format!("{base}/linux.zip.sha256")),
        &dir,
        "linux.zip",
        "jitter",
        64 * 1024 * 1024,
        false,
    )
    .await;
    stop.store(true, Ordering::SeqCst);
    assert!(result.expect_err("错误架构包必须拒绝").contains("jitter"));
    assert!(!dir.join("jitter").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

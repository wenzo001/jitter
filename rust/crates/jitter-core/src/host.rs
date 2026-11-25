//! 主机环境探测：AC 电源状态、本机 IPv4 地址、网络连接状态与「防止系统休眠」。
//!
//! 电源与网卡信息只用于「执行条件」：某些打卡 / 内网 curl 必须在插电、
//! 连着网（WiFi 或网线）、且连在公司网段时才执行。防休眠是全局设置：
//! 只有接通电源时才阻止系统空闲休眠，电池供电时仍然交给系统省电。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostEnvironment {
    /// `None` 表示无法判断（例如系统不提供电源信息）。
    pub on_ac_power: Option<bool>,
    pub local_ips: Vec<String>,
    /// 当前已连接的网络接口（WiFi / 有线）。
    pub networks: Vec<NetworkConnection>,
}

pub fn current_environment() -> HostEnvironment {
    HostEnvironment {
        on_ac_power: on_ac_power(),
        local_ips: local_ipv4_addresses(),
        networks: network_connections(),
    }
}

/// 是否接通电源。`None` = 无法判断。
pub fn on_ac_power() -> Option<bool> {
    platform::on_ac_power()
}

/// 本机全部非回环 IPv4 地址（已去重）。
pub fn local_ipv4_addresses() -> Vec<String> {
    platform::local_ipv4_addresses()
}

// ---------------------------------------------------------------------------
// 网络连接（WiFi / 网线）
// ---------------------------------------------------------------------------

/// 网络接口类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkKind {
    /// 无线（WiFi）。
    Wifi,
    /// 有线（网线）。
    Ethernet,
    /// 其它（认不出具体类型的网卡）。
    Other,
}

impl NetworkKind {
    pub fn label(self) -> &'static str {
        match self {
            NetworkKind::Wifi => "WiFi",
            NetworkKind::Ethernet => "以太网",
            NetworkKind::Other => "网络",
        }
    }

    /// 稳定的英文标识（前端 / JSON 用）。
    pub fn as_str(self) -> &'static str {
        match self {
            NetworkKind::Wifi => "wifi",
            NetworkKind::Ethernet => "ethernet",
            NetworkKind::Other => "other",
        }
    }
}

/// 一个已连接的网络接口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkConnection {
    /// 接口名（Windows 是适配器名称，如「WLAN」「以太网」）。
    pub name: String,
    pub kind: NetworkKind,
}

/// 当前**已连接**的网络接口（WiFi 或有线）。
///
/// 只统计「已启用 + 拿到了地址 + 不是虚拟网卡 / 回环」的接口：
/// 拔掉网线、关掉 WiFi 之后这里就会变空。
pub fn network_connections() -> Vec<NetworkConnection> {
    platform::network_connections()
}

// ---------------------------------------------------------------------------
// 防止系统休眠
// ---------------------------------------------------------------------------

static PREVENT_SLEEP_ENABLED: AtomicBool = AtomicBool::new(false);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
static SLEEP_WATCHER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

/// 打开 / 关闭「接通电源时防止系统休眠」。
///
/// 首次开启会起一个守护线程，每 30 秒重新判断电源状态：插电时保持唤醒，
/// 拔掉电源立刻恢复系统默认的休眠行为。
pub fn set_prevent_sleep(enabled: bool) {
    PREVENT_SLEEP_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        ensure_watcher();
    } else {
        platform::apply_keep_awake(false);
    }
}

fn ensure_watcher() {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = std::thread::Builder::new()
        .name("jitter-keep-awake".to_string())
        .spawn(|| loop {
            let enabled = PREVENT_SLEEP_ENABLED.load(Ordering::SeqCst);
            // 电源状态未知时按「已接通」处理：宁可多保持唤醒，也不漏掉定时任务。
            let keep_awake = enabled && on_ac_power() != Some(false);
            platform::apply_keep_awake(keep_awake);
            std::thread::sleep(std::time::Duration::from_secs(30));
        });
    if let Ok(handle) = handle {
        if let Ok(mut slot) = SLEEP_WATCHER.lock() {
            *slot = Some(handle);
        }
    }
}

fn is_useful_ipv4(ip: &str) -> bool {
    ip != "0.0.0.0" && !ip.starts_with("127.") && !ip.starts_with("169.254.")
}

/// 虚拟网卡 / 隧道 / 回环：它们「有地址」不代表真的连着网，一律不算。
fn is_virtual_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    const VIRTUAL_HINTS: [&str; 13] = [
        "virtual", "vmware", "virtualbox", "hyper-v", "vethernet", "loopback", "tunnel", "tap-",
        "wsl", "docker", "bluetooth", "vpn", "tailscale",
    ];
    VIRTUAL_HINTS.iter().any(|hint| lower.contains(hint))
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};
    use windows_sys::Win32::System::Power::{
        GetSystemPowerStatus, SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        SYSTEM_POWER_STATUS,
    };

    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    /// IANA 的接口类型：6 = 以太网，71 = IEEE 802.11（WiFi）。
    const IF_TYPE_ETHERNET: u32 = 6;
    const IF_TYPE_IEEE80211: u32 = 71;

    pub fn on_ac_power() -> Option<bool> {
        let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetSystemPowerStatus(&mut status) };
        if ok == 0 {
            return None;
        }
        match status.ACLineStatus {
            0 => Some(false),
            1 => Some(true),
            // 255 = 未知。
            _ => None,
        }
    }

    pub fn local_ipv4_addresses() -> Vec<String> {
        let mut ips: Vec<String> = Vec::new();
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size: u32 = 15_000;
        for _ in 0..3 {
            let mut buffer: Vec<u8> = vec![0; size as usize];
            let result = unsafe {
                GetAdaptersAddresses(
                    AF_INET as u32,
                    flags,
                    std::ptr::null(),
                    buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                    &mut size,
                )
            };
            if result == 0 {
                collect(&buffer, &mut ips);
                break;
            }
            if result != ERROR_BUFFER_OVERFLOW {
                break;
            }
        }
        ips
    }

    fn collect(buffer: &[u8], ips: &mut Vec<String>) {
        let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            let current = unsafe { &*adapter };
            let mut unicast = current.FirstUnicastAddress;
            while !unicast.is_null() {
                let node = unsafe { &*unicast };
                let socket = node.Address;
                if !socket.lpSockaddr.is_null()
                    && socket.iSockaddrLength >= std::mem::size_of::<SOCKADDR_IN>() as i32
                {
                    let address = unsafe { &*(socket.lpSockaddr as *const SOCKADDR_IN) };
                    if address.sin_family == AF_INET {
                        let bytes = unsafe { address.sin_addr.S_un.S_un_b };
                        let ip = format!(
                            "{}.{}.{}.{}",
                            bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4
                        );
                        if super::is_useful_ipv4(&ip) && !ips.contains(&ip) {
                            ips.push(ip);
                        }
                    }
                }
                unicast = node.Next;
            }
            adapter = current.Next;
        }
    }

    pub fn apply_keep_awake(keep: bool) {
        let flags = if keep {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        unsafe {
            SetThreadExecutionState(flags);
        }
    }

    /// 已连接的有线 / 无线网卡。
    ///
    /// 判据：适配器处于 Up、接口类型是以太网或 WiFi、并且拿到了可用的 IPv4。
    /// 虚拟网卡（VMware / Hyper-V / WSL…）按名字排除，否则它们会让条件永远成立。
    pub fn network_connections() -> Vec<super::NetworkConnection> {
        let mut out: Vec<super::NetworkConnection> = Vec::new();
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size: u32 = 15_000;
        for _ in 0..3 {
            let mut buffer: Vec<u8> = vec![0; size as usize];
            let result = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC as u32,
                    flags,
                    std::ptr::null(),
                    buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                    &mut size,
                )
            };
            if result == 0 {
                collect_connections(&buffer, &mut out);
                break;
            }
            if result != ERROR_BUFFER_OVERFLOW {
                break;
            }
        }
        out
    }

    fn collect_connections(
        buffer: &[u8],
        out: &mut Vec<super::NetworkConnection>,
    ) {
        use super::NetworkKind;

        let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !adapter.is_null() {
            let current = unsafe { &*adapter };
            let if_type = current.IfType;
            let name = wide_string(current.FriendlyName);
            let up = current.OperStatus == IfOperStatusUp;
            let physical = if_type == IF_TYPE_ETHERNET || if_type == IF_TYPE_IEEE80211;
            if up && physical && has_usable_ipv4(current) && !super::is_virtual_adapter(&name) {
                let kind = if if_type == IF_TYPE_IEEE80211 {
                    NetworkKind::Wifi
                } else {
                    NetworkKind::Ethernet
                };
                let label = if name.is_empty() {
                    kind.label().to_string()
                } else {
                    name
                };
                out.push(super::NetworkConnection { name: label, kind });
            }
            adapter = current.Next;
        }
    }

    /// 适配器是否拿到了可用的 IPv4。
    fn has_usable_ipv4(adapter: &IP_ADAPTER_ADDRESSES_LH) -> bool {
        let mut unicast = adapter.FirstUnicastAddress;
        while !unicast.is_null() {
            let node = unsafe { &*unicast };
            let socket = node.Address;
            if !socket.lpSockaddr.is_null()
                && socket.iSockaddrLength >= std::mem::size_of::<SOCKADDR_IN>() as i32
            {
                let address = unsafe { &*(socket.lpSockaddr as *const SOCKADDR_IN) };
                if address.sin_family == AF_INET {
                    let bytes = unsafe { address.sin_addr.S_un.S_un_b };
                    let ip = format!(
                        "{}.{}.{}.{}",
                        bytes.s_b1, bytes.s_b2, bytes.s_b3, bytes.s_b4
                    );
                    if super::is_useful_ipv4(&ip) {
                        return true;
                    }
                }
            }
            unicast = node.Next;
        }
        false
    }

    /// PWSTR → String（读到第一个 NUL 为止）。
    fn wide_string(value: windows_sys::core::PWSTR) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
                if len > 512 {
                    break;
                }
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
        }
    }
}

// ---------------------------------------------------------------------------
// macOS / Linux
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod platform {
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;

    static INHIBITOR: Mutex<Option<Child>> = Mutex::new(None);

    #[cfg(target_os = "macos")]
    pub fn on_ac_power() -> Option<bool> {
        let output = Command::new("pmset").args(["-g", "batt"]).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.contains("AC Power") {
            Some(true)
        } else if text.contains("Battery Power") {
            Some(false)
        } else {
            None
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn on_ac_power() -> Option<bool> {
        // Linux：/sys/class/power_supply/*/online。没有任何可读文件时
        // （台式机 / 容器）视为一直接通电源。
        let entries = std::fs::read_dir("/sys/class/power_supply").ok()?;
        let mut saw_online = false;
        let mut saw_offline = false;
        for entry in entries.flatten() {
            if let Ok(text) = std::fs::read_to_string(entry.path().join("online")) {
                match text.trim() {
                    "1" => saw_online = true,
                    "0" => saw_offline = true,
                    _ => {}
                }
            }
        }
        if saw_online {
            Some(true)
        } else if saw_offline {
            Some(false)
        } else {
            Some(true)
        }
    }

    pub fn local_ipv4_addresses() -> Vec<String> {
        let mut ips: Vec<String> = Vec::new();
        unsafe {
            let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut head) != 0 {
                return ips;
            }
            let mut cursor = head;
            while !cursor.is_null() {
                let entry = &*cursor;
                if !entry.ifa_addr.is_null() && (*entry.ifa_addr).sa_family as i32 == libc::AF_INET
                {
                    let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                    let ip =
                        std::net::Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr)).to_string();
                    if super::is_useful_ipv4(&ip) && !ips.contains(&ip) {
                        ips.push(ip);
                    }
                }
                cursor = entry.ifa_next;
            }
            libc::freeifaddrs(head);
        }
        ips
    }

    pub fn apply_keep_awake(keep: bool) {
        let Ok(mut slot) = INHIBITOR.lock() else {
            return;
        };
        if keep {
            // 抑制进程可能因缺少 D-Bus / systemd 立即退出：下一轮重新拉起。
            if let Some(child) = slot.as_mut() {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    *slot = None;
                }
            }
            if slot.is_none() {
                *slot = spawn_inhibitor();
            }
        } else if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// 已连接的有线 / 无线网卡。
    ///
    /// 判据：接口拿到了可用的 IPv4、不是回环 / 虚拟网卡、且不是隧道。
    /// Linux 上用 `/sys/class/net/<name>` 判断接口类型与是否 up；
    /// macOS 上有线与无线都叫 `en*`，只能判断「有没有连上」。
    pub fn network_connections() -> Vec<super::NetworkConnection> {
        use super::NetworkKind;

        let mut out: Vec<super::NetworkConnection> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        unsafe {
            let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut head) != 0 {
                return out;
            }
            let mut cursor = head;
            while !cursor.is_null() {
                let entry = &*cursor;
                if !entry.ifa_addr.is_null() && (*entry.ifa_addr).sa_family as i32 == libc::AF_INET
                {
                    let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                    let ip =
                        std::net::Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr)).to_string();
                    if super::is_useful_ipv4(&ip) {
                        let name = c_string(entry.ifa_name);
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                }
                cursor = entry.ifa_next;
            }
            libc::freeifaddrs(head);
        }

        for name in names {
            if super::is_virtual_adapter(&name) || !interface_is_usable(&name) {
                continue;
            }
            #[cfg(target_os = "macos")]
            {
                // macOS 上有线和无线都是 en*，系统接口不暴露介质类型。
                if !name.starts_with("en") {
                    continue;
                }
                out.push(super::NetworkConnection {
                    name,
                    kind: NetworkKind::Other,
                });
            }
            #[cfg(not(target_os = "macos"))]
            {
                let kind = if std::path::Path::new(&format!("/sys/class/net/{name}/wireless")).exists()
                {
                    NetworkKind::Wifi
                } else if interface_is_ethernet(&name) {
                    NetworkKind::Ethernet
                } else {
                    NetworkKind::Other
                };
                out.push(super::NetworkConnection { name, kind });
            }
        }
        out
    }

    /// Linux：接口是否处于可用状态（operstate 不是 down）。
    fn interface_is_usable(name: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            let _ = name;
            true
        }
        #[cfg(not(target_os = "macos"))]
        {
            match std::fs::read_to_string(format!("/sys/class/net/{name}/operstate")) {
                Ok(text) => text.trim() != "down",
                // 读不到（例如容器里没有 /sys/class/net）就当它可用。
                Err(_) => true,
            }
        }
    }

    /// Linux：`/sys/class/net/<name>/type` 为 1 表示以太网。
    fn interface_is_ethernet(name: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            let _ = name;
            false
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::fs::read_to_string(format!("/sys/class/net/{name}/type"))
                .map(|text| text.trim() == "1")
                .unwrap_or(false)
        }
    }

    /// C 字符串 → String。
    fn c_string(value: *const libc::c_char) -> String {
        if value.is_null() {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(value) }
            .to_string_lossy()
            .to_string()
    }

    #[cfg(target_os = "macos")]
    fn spawn_inhibitor() -> Option<Child> {
        // -s：只在接通电源时阻止系统休眠；-i：阻止空闲休眠。
        Command::new("caffeinate")
            .args(["-i", "-s"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()
    }

    #[cfg(not(target_os = "macos"))]
    fn spawn_inhibitor() -> Option<Child> {
        // 有 systemd 的发行版可用；找不到命令时静默降级为不休眠干预。
        Command::new("systemd-inhibit")
            .args([
                "--what=sleep:idle",
                "--who=Jitter",
                "--why=接通电源时保持唤醒以执行定时任务",
                "--mode=block",
                "tail",
                "-f",
                "/dev/null",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()
    }
}

// ---------------------------------------------------------------------------
// 其它平台（保持可编译）
// ---------------------------------------------------------------------------

#[cfg(not(any(windows, unix)))]
mod platform {
    pub fn on_ac_power() -> Option<bool> {
        None
    }

    pub fn local_ipv4_addresses() -> Vec<String> {
        Vec::new()
    }

    pub fn network_connections() -> Vec<super::NetworkConnection> {
        Vec::new()
    }

    pub fn apply_keep_awake(_keep: bool) {}
}

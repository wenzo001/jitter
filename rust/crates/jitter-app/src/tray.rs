//! Windows 托盘：程序生成的 RGBA 占位图标 + 菜单。
//!
//! 菜单：打开界面 / 重启 / 开机自启（勾选）/ 退出；左键点托盘直接打开界面。
//! muda 的菜单项是 Rc（不可跨线程），因此菜单事件与 Win32 消息统一在
//! 托盘线程的一个循环里处理，不做跨线程转发。

#[cfg(windows)]
mod imp {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    use muda::{ContextMenu, IsMenuItem, Menu, MenuEvent, MenuItem, CheckMenuItem};
    use tokio_util::sync::CancellationToken;
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};

    /// 启动托盘线程。失败只打日志：托盘是增强件，不阻塞主服务。
    pub fn spawn(port: u16, quit: CancellationToken) {
        std::thread::spawn(move || {
            if let Err(error) = run(port, quit) {
                tracing::warn!("托盘不可用: {error}");
            }
        });
    }

    fn run(port: u16, quit: CancellationToken) -> Result<(), Box<dyn std::error::Error>> {
        let icon = Icon::from_rgba(icon_rgba(32), 32, 32)?;
        let menu = Menu::new();

        let open = MenuItem::new("打开界面", true, None);
        let restart = MenuItem::new("重启", true, None);
        let autostart = CheckMenuItem::new("开机自启", true, jitter_core::system::is_autostart_enabled(), None);
        let exit = MenuItem::new("退出", true, None);
        let items: [&dyn IsMenuItem; 4] = [&open, &restart, &autostart, &exit];
        menu.append_items(&items)?;
        // 必须持有：TrayIcon 掉了托盘就消失。
        let _tray = TrayIconBuilder::new()
            .with_icon(icon)
            .with_tooltip("Jitter")
            .with_menu(Box::new(menu))
            .build()?;

        event_loop(port, &quit, &open, &restart, &autostart, &exit);
        Ok(())
    }

    /// 统一事件循环：菜单事件（全局频道）+ 左键点托盘 + Win32 消息。
    /// 全部在托盘线程上处理，菜单项（Rc）不需要跨线程。
    fn event_loop(
        port: u16,
        quit: &CancellationToken,
        open: &MenuItem,
        restart: &MenuItem,
        autostart: &CheckMenuItem,
        exit: &MenuItem,
    ) {
        let open_id = open.id().0.clone();
        let restart_id = restart.id().0.clone();
        let autostart_id = autostart.id().0.clone();
        let exit_id = exit.id().0.clone();
        loop {
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                let id = event.id.0.clone();
                if id == open_id {
                    open_browser(port);
                } else if id == restart_id {
                    restart_app(quit);
                } else if id == autostart_id {
                    let enabled = jitter_core::system::is_autostart_enabled();
                    match jitter_core::system::set_autostart(!enabled) {
                        Ok(()) => autostart.set_checked(!enabled),
                        Err(error) => tracing::warn!("切换开机自启失败: {error}"),
                    }
                } else if id == exit_id {
                    quit.cancel();
                }
            }
            while let Ok(event) = TrayIconEvent::receiver().try_recv() {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    open_browser(port);
                }
            }
            unsafe { pump_messages_nonblocking() };
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// 重启：等本进程优雅退出（释放端口）后再拉起新实例。
    fn restart_app(quit: &CancellationToken) {
        let Some(current) = jitter_core::system::get_binary_path() else {
            quit.cancel();
            return;
        };
        let helper = current.parent().map(PathBuf::from).unwrap_or_default().join("jitter-restart.cmd");
        let script = format!(
            "@echo off\r\n\
ping -n 4 127.0.0.1 >nul\r\n\
start \"\" \"{}\"\r\n\
del \"%~f0\" >nul 2>&1\r\n",
            current.display()
        );
        if let Err(error) = fs::write(&helper, script) {
            tracing::warn!("写重启辅助脚本失败: {error}");
            quit.cancel();
            return;
        }
        let mut command = Command::new("cmd");
        command.args(["/c", &helper.to_string_lossy()]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = command.creation_flags(0x0000_0008); // DETACHED_PROCESS
        }
        if let Err(error) = command.spawn() {
            tracing::warn!("启动重启脚本失败: {error}");
        }
        quit.cancel();
    }

    /// 程序生成的占位图标：靛蓝圆面 + 时钟指针（RGBA）。
    fn icon_rgba(size: u32) -> Vec<u8> {
        let s = size as i32;
        let center = s / 2;
        let radius = (s * 2 / 5) as f64;
        let mut data = Vec::with_capacity((size as usize) * (size as usize) * 4);
        for y in 0..s {
            for x in 0..s {
                let dx = x as f64 - center as f64;
                let dy = y as f64 - center as f64;
                let inside = (dx * dx + dy * dy) <= radius * radius;
                // 指针：向上的竖针 + 向右的横针。
                let hand_up = (x - center).abs() <= 1 && y <= center;
                let hand_right = (y - center).abs() <= 1 && x >= center;
                let (r, g, b, a) = if !inside {
                    (0, 0, 0, 0)
                } else if hand_up || hand_right {
                    (255, 255, 255, 255)
                } else {
                    (63, 81, 181, 255)
                };
                data.extend_from_slice(&[r, g, b, a]);
            }
        }
        data
    }

    fn open_browser(port: u16) {
        let url = format!("http://127.0.0.1:{port}");
        let mut command = Command::new("cmd");
        command.args(["/c", "start", "", &url]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = command.creation_flags(0x0800_0000).spawn(); // CREATE_NO_WINDOW
        }
    }

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Msg {
        hwnd: isize,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
        private: usize,
    }

    const PM_REMOVE: u32 = 1;

    extern "system" {
        fn PeekMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32, flags: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    /// 非阻塞泵：把当前排队中的窗口消息全部分发（tray-icon / muda 靠它们）。
    unsafe fn pump_messages_nonblocking() {
        let mut msg: Msg = std::mem::zeroed();
        while PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(windows)]
pub use imp::spawn;

/// 非 Windows：没有原生事件循环可用，托盘暂缺，程序以纯服务形态运行。
#[cfg(not(windows))]
pub fn spawn(_port: u16, _quit: tokio_util::sync::CancellationToken) {}

//! Windows 托盘：程序生成的 RGBA 占位图标 + 菜单（打开界面 / 退出）。
//!
//! tray-icon 与 muda 都要求「创建它们的线程」跑一个 Win32 消息循环，因此
//! 托盘在独立线程上创建并泵消息；菜单事件经全局 channel 转发到动作。

#[cfg(windows)]
mod imp {
    use std::process::Command;

    use muda::{ContextMenu, IsMenuItem, Menu, MenuEvent, MenuItem};
    use tokio_util::sync::CancellationToken;
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

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
        let exit = MenuItem::new("退出", true, None);
        let items: [&dyn IsMenuItem; 2] = [&open, &exit];
        menu.append_items(&items)?;
        // 必须持有：TrayIcon 掉了托盘就消失。
        let _tray = TrayIconBuilder::new()
            .with_icon(icon)
            .with_tooltip("Jitter")
            .with_menu(Box::new(menu))
            .build()?;

        let open_id = open.id().clone();
        let exit_id = exit.id().clone();
        std::thread::spawn(move || loop {
            let Ok(event) = MenuEvent::receiver().recv() else {
                break;
            };
            if event.id == open_id {
                open_browser(port);
            } else if event.id == exit_id {
                quit.cancel();
            }
        });

        unsafe { pump_messages() };
        Ok(())
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

    extern "system" {
        fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }

    /// Win32 消息循环：tray-icon / muda 都靠它分发事件。
    unsafe fn pump_messages() {
        let mut msg: Msg = std::mem::zeroed();
        loop {
            let result = GetMessageW(&mut msg, 0, 0, 0);
            if result <= 0 {
                break;
            }
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

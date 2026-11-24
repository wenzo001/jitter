//! Windows 托盘：程序生成的 RGBA 占位图标 + 菜单。
//!
//! 菜单：打开界面 / 重启 / 开机自启（勾选）/ 退出；左键点托盘直接打开界面。
//! muda 的菜单项是 Rc（不可跨线程），因此菜单事件与 Win32 消息统一在
//! 托盘线程的一个循环里处理，不做跨线程转发。

#[cfg(windows)]
mod imp {
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
        let icon = Icon::from_rgba(icon_rgba(64), 64, 64)?;
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

    /// 重启：直接拉起新实例（带启动延迟等本进程释放端口与单实例锁），
    /// 不走 cmd 辅助脚本（避免弹控制台窗口）。
    fn restart_app(quit: &CancellationToken) {
        let Some(current) = jitter_core::system::get_binary_path() else {
            quit.cancel();
            return;
        };
        let mut command = Command::new(&current);
        command
            .env("JITTER_STARTUP_DELAY_MS", "1500")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0000_0008); // DETACHED_PROCESS
        }
        if let Err(error) = command.spawn() {
            tracing::warn!("启动重启实例失败: {error}");
        }
        quit.cancel();
    }

    /// 程序生成的图标：紫→蓝渐变圆角方块 + 白色圆环（4× 超采样抗锯齿）。
    /// 与 web/src/assets/favicon.svg、exe 资源图标（build.rs 嵌入 jitter.ico）
    /// 为同一设计，三处保持统一。
    fn icon_rgba(size: u32) -> Vec<u8> {
        const SS: u32 = 4; // 每像素 4×4 子采样
        let b = (size * SS) as f64;
        let margin = b * 0.052;
        let corner = b * 0.26;
        let cx = b / 2.0;
        let cy = b / 2.0;
        let half = b / 2.0 - margin;
        let ring_r = b * 0.295;
        let ring_w = b * 0.078;
        let mut out = vec![0u8; (size * size * 4) as usize];
        for py in 0..size {
            for px in 0..size {
                let (mut r, mut g, mut bl, mut al) = (0f64, 0f64, 0f64, 0f64);
                for sy in 0..SS {
                    for sx in 0..SS {
                        let x = (px * SS + sx) as f64 + 0.5;
                        let y = (py * SS + sy) as f64 + 0.5;
                        if sd_round_rect(x, y, cx, cy, half, corner) > 0.0 {
                            continue;
                        }
                        // 顶部紫罗兰 #B44DFF → 底部蓝 #5F7BFF 的竖向渐变。
                        let t = (y / b).clamp(0.0, 1.0);
                        let mut color = (
                            180.0 + (95.0 - 180.0) * t,
                            77.0 + (123.0 - 77.0) * t,
                            255.0 + (255.0 - 255.0) * t,
                        );
                        let d_center = dist(x, y, cx, cy);
                        let d_ring = (d_center - ring_r).abs() - ring_w / 2.0;
                        if d_ring <= 0.0 {
                            color = (255.0, 255.0, 255.0);
                        }
                        r += color.0;
                        g += color.1;
                        bl += color.2;
                        al += 255.0;
                    }
                }
                let n = (SS * SS) as f64;
                let idx = ((py * size + px) * 4) as usize;
                out[idx] = (r / n) as u8;
                out[idx + 1] = (g / n) as u8;
                out[idx + 2] = (bl / n) as u8;
                out[idx + 3] = (al / n) as u8;
            }
        }
        out
    }

    fn dist(x: f64, y: f64, cx: f64, cy: f64) -> f64 {
        ((x - cx).powi(2) + (y - cy).powi(2)).sqrt()
    }

    /// 圆角矩形的有符号距离（<= 0 在内部）。
    fn sd_round_rect(x: f64, y: f64, cx: f64, cy: f64, half: f64, corner: f64) -> f64 {
        let dx = (x - cx).abs() - (half - corner);
        let dy = (y - cy).abs() - (half - corner);
        let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
        outside + dx.max(dy).min(0.0) - corner
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

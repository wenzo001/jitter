use std::path::PathBuf;

fn main() {
    let dist = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../web/dist");
    let index = dist.join("index.html");
    if !index.exists() {
        panic!(
            "前端产物缺失：{}。请先在 web/ 目录运行 `bun install && bun run build`。",
            index.display()
        );
    }
    println!("cargo:rerun-if-changed={}", dist.display());

    // Windows 资源管理器 / 任务栏 / 快捷方式显示的 exe 图标；
    // 托盘图标由 tray.rs 运行时生成，两者为同一设计。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=jitter.ico");
        winresource::WindowsResource::new()
            .set_icon("jitter.ico")
            .compile()
            .expect("嵌入 Windows 图标失败");
    }
}

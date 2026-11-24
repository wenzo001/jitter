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
}

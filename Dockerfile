# 多阶段构建：前端（bun 只作为包管理器/构建工具） -> Rust 后端 -> 精简运行镜像
# 说明：仓库里已没有 Bun/TypeScript 后端，镜像只承载 rust/ 编译出的 jitter 二进制。

# ---------- 阶段 1：前端产物 ----------
FROM oven/bun:1.4.4 AS frontend
WORKDIR /app/web

# web/bun.lock 已入库，先只拷贝清单 + 锁文件，保证依赖层缓存命中。
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

# 只拷贝前端源码与构建配置：不整体 COPY web/，否则宿主机的
# web/node_modules（Windows 原生二进制）会污染容器里的 bun install。
# web/ 下若新增顶层资源目录（如 public/），需要在这里补一条 COPY。
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src/ ./src/

RUN bun run build

# ---------- 阶段 2：Rust 后端 ----------
FROM rust:1-bookworm AS backend
WORKDIR /app

# rusqlite 使用 bundled 特性（自带 SQLite 源码），ring 也要本地编译，
# 因此构建阶段必须有 C 编译器。
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

# 逐项拷贝，避免把宿主机的 rust/target（本机可达 10GB+）带进构建上下文。
# （.dockerignore 不在本次改动范围内，因此这里显式排除 target。）
COPY rust/Cargo.toml rust/Cargo.lock ./rust/
COPY rust/crates/jitter-core/ ./rust/crates/jitter-core/
COPY rust/crates/jitter-app/ ./rust/crates/jitter-app/

# jitter-app 的 build.rs 会校验 <repo>/web/dist/index.html，
# 嵌入路径是 rust/crates/jitter-app/../../../web/dist，所以前端产物必须先就位。
COPY --from=frontend /app/web/dist ./web/dist

# 产物二进制名为 jitter（见 rust/crates/jitter-app/Cargo.toml 的 [[bin]]）。
# 必须在工作区根目录（/app/rust）执行 cargo，产物落在 /app/rust/target/release/jitter。
WORKDIR /app/rust
RUN cargo build --release -p jitter-app

# ---------- 阶段 3：运行镜像 ----------
FROM debian:bookworm-slim AS runtime

# SQLite 为 bundled 静态链接，运行阶段不需要 libsqlite3；
# 仅保留 ca-certificates 供 HTTPS 请求使用。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HOST=0.0.0.0 \
    PORT=3000 \
    JITTER_CONFIG=/app/jitter.config.json \
    JITTER_DB_PATH=/app/data/app.db

COPY --from=backend /app/rust/target/release/jitter /app/jitter
COPY jitter.config.json /app/jitter.config.json

# 数据库与日志（<db 同级>/logs）都落在数据卷里。
RUN mkdir -p /app/data/logs

EXPOSE 3000

CMD ["/app/jitter"]

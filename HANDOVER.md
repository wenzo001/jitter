# Jitter 交接说明

> 最后更新：2026-11-23（第三次） · 全面功能对齐审查完成

## 一、一句话现状

**Rust 版已通过与 TS 版逐接口对齐的完整审查：五步测试台、调度预览、测试留档、日志游标分页、同步立即执行、任务生命周期（停/恢复/暂停）、清理确认链全部补齐；两处自死锁与前端一个致命语法错误已修复。v1.0.1 起可直接替代 Bun 版使用。**

---

## 二、这个项目是什么

一个「定时 / 循环执行 HTTP 请求」的小工具：

- 任务来源：粘贴浏览器里复制出来的 **curl 命令**（自动解析成请求），或结构化填写
- 调度：每天在 HH:mm–HH:mm 窗口内随机一次、精确时间 ± 抖动、或每隔 N 秒/分/时/天（可加抖动、可设首跑锚点）
- 执行前判断：可选的前置请求 + 「只在某些星期 / 某个时段」的本地条件
- 结果判定：期望状态码 / 期望正文 / 表达式（如 `data.code=0`）
- 命中后通知：再发一个 curl
- 网页是唯一界面：任务、日志（含请求/响应全文与截断标记）、统计、测试台、设置、数据库备份

典型用途：每天自动打卡、定时签到、循环回调自己的服务。

---

## 三、两条代码线

| | TypeScript 版（线上） | Rust 版（在移植，目标转正） |
|---|---|---|
| 入口 | `src/index.ts` | `rust/crates/jitter-app/src/main.rs` |
| 运行时 | Bun + Elysia | axum + tokio |
| 数据库 | `bun:sqlite` | `rusqlite`（bundled SQLite） |
| 前端 | `src/frontend/*` | **同一份文件，`include_str!` 嵌入** |
| 产物 | `dist/jitter.exe` **111MB** | debug 13MB（release 预计 8–10MB） |
| 测试 | `bun test` → **360 项** | `cargo test` → **198 项** |
| 状态 | 功能完整，可直接用 | 核心跑通，缺桌面集成与发布 |

**关键约定：前端零改动。** Rust 版实现同一套 API（同路径、同状态码、同 JSON 字段），所以 `src/frontend/` 是两个版本共用的。

---

## 四、目录地图

```
src/                      TypeScript 版
├── index.ts              启动：配置 → 数据库 → 调度器 → HTTP
├── api.ts                全部 HTTP 路由
├── db.ts                 SQLite schema / 迁移 / CRUD / 保留清理
├── scheduler.ts          定时器与执行编排
├── executor.ts           传输层（重试 / 代理回退 / 超时 / 截断）+ 前置判断 + 通知
├── schedule.ts           调度模型（daily / interval）
├── window.ts             跨午夜窗口、暂停区间、恢复计划
├── condition.ts          表达式求值器（安全的类 JS 表达式）
├── curl-parser.ts        curl 命令解析
├── guard.ts              星期 / 时段本地判断
├── metrics.ts            统计
├── system.ts             版本、路径、开机自启、退出
├── updater.ts            GitHub Releases 检查与自替换
├── backup.ts / restore.ts 数据库备份 / 导出 / 导入 / 恢复
├── proxy.ts              环境代理失效自动回退
└── frontend/             网页（两个版本共用）

rust/
├── crates/jitter-core/   纯逻辑库（可单测，不依赖 HTTP 框架）
│   └── src/{condition,window,schedule,curl_parser,guard,db,executor,config,metrics,types}.rs
└── crates/jitter-app/    可执行程序
    └── src/{main,api,scheduler}.rs

data/app.db               你的真实数据库（不要删）
data/backups/             备份目录
```

---

## 五、怎么跑 / 怎么测 / 怎么打包

### TypeScript 版

```bash
bun run start        # 启动（默认 http://127.0.0.1:3000）
bun run dev          # 热重载
bun test             # 360 项测试
bun run typecheck    # tsc --noEmit
bun run build        # 打包 → dist/jitter.exe（111MB）
```

### Rust 版

```bash
cd rust
cargo run -p jitter-app                 # 直接跑
cargo test -p jitter-core               # 198 项测试
cargo build --release -p jitter-app     # 出包
```

⚠️ **本机编译必须加这两个环境变量**，否则会报"元数据损坏"：

```bash
export CARGO_PROFILE_DEV_DEBUG=0        # 关 debuginfo，省内存
cargo build ... --jobs 1                # 串行编译
```

原因见第九节。

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 端口 | 3000（被占用时自动 +1） |
| `JITTER_DB_PATH` | 数据库路径 | `data/app.db` |
| `JITTER_CONFIG` | 配置文件路径 | `jitter.config.json` |

---

## 六、你必须要知道的几个设计决策

1. **窗口实例按「开始日」归属**。23:50–00:10 属于开始那天，所以 D+1 的 00:05 仍是 D 的这一次。暂停、星期判断、恢复计划全依赖这条。
2. **暂停是整自然日**，不是「从现在起 N×24 小时」。「今天开始」会连今天下午的窗口一起跳过；「明天开始」不碰今天。
3. **错过判定**：daily 看窗口是否仍开着；interval 有 5–60 秒的迟到容差，超了记 `missed` 而不是补跑。
4. **执行器只对「连接被重置」重试**（最多 2 次，带 `Connection: close`）。HTTP 错误码是正常响应，不重试。
5. **环境代理探测超时会自动回退直连**，但用户显式 `-x` 指定的代理绝不改写。
6. **响应体按 100 KiB 截断**，截断的正文不参与「期望正文 / 表达式」判定（会判失败而不是误判成功）。
7. **备份用 `VACUUM INTO`**：活库上直接做完整快照（自动合并 WAL，不停服务），产物是标准 SQLite 文件。
8. **恢复前自动另存当前状态**，所以恢复永远不会悄悄丢数据。

---

## 七、数据安全（重点）

- 真实库：`data/app.db`（WAL 模式，`-wal` / `-shm` 是它的搭档文件，别单独删）
- 已有备份：`data/backups/jitter-20261123-112049.db`（含 2 个任务）
- 网页「设置 → 备份与恢复」支持：新建备份 / 下载导出 / 上传导入 / 恢复 / 删除
- 路径穿越已防：备份文件名严格白名单，`../app.db`、`C:\evil\app.db` 都被拒绝（有测试）
- **删除数据库文件之前先做备份**；恢复旧备份后启动会自动跑迁移，老 schema 也能升上来

---

## 八、当前进度

### TypeScript 版：功能完整 ✅

任务 CRUD 与拖动排序、三种调度、前置判断（curl + 星期/时段）、通知、日志分页与全文、执行中断、测试台五步链、统计、日志清理与保留策略、设置面板（版本/自启/升级/退出）、数据库备份导出导入恢复。

### Rust 版：核心跑通 ✅

| 模块 | 状态 | 测试 |
|---|---|---|
| condition（表达式求值） | ✅ | 23 |
| window（窗口 / 暂停 / 恢复） | ✅ | 47 |
| schedule（daily / interval / 锚点 / 漂移） | ✅ | 37 |
| curl_parser（分词 / 参数映射） | ✅ | 46 |
| guard（星期 / 时段） | ✅ | 13 |
| db（同 schema / 迁移 / CRUD / 清理） | ✅ | 13 |
| executor（重试 / 代理 / 超时 / 截断 / 通知） | ✅ | 19 |
| config / metrics | ✅ | — |
| api（axum 全核心路由） | ✅ | — |
| scheduler（tokio 定时器） | ✅ | — |

实测：启动 → 首页 52KB + app.js 114KB 正常 → 从 curl 建任务 → 触发执行 → 200 入库 `matched=1`。

### 还缺什么（按顺序）

~~原五项已全部完成~~；v1.0.1 完成了「Rust 与 TS 功能完全对齐」的全面审查，修复内容：

- **补齐的接口**：`POST /api/schedule/preview`（接下来 7 次预览）、`POST /api/test/run`（测试台五步链，移植为 `jitter-core/src/testbench.rs`）、`GET /api/tasks/:id/test-runs` 与 `GET /api/test-runs/:id`（测试留档）、`GET /api/logs/cleanup/preview`。
- **修复的契约错位**：任务载荷按前端真实形状解析（**扁平的 `notify_enabled`/`notify_curl`/`precheck_*` 字段与文本型 headers**——v1.0.0 误按对象解析，通知与前置判断会被静默丢弃）；`/api/tasks/:id/run` 改为同步返回完整执行结果；任务视图补 `running`/`running_since`/`schedule_error`；日志分页改 `before` 游标 + `has_more` + 保留窗口过滤；`/api/metrics`、`/api/logs/cleanup*` 改为直接返回对象（与 TS 版一致）；`/api/config` 补生效保留天数；全部校验规则对齐（状态码 100–599、名称 200 字、表达式校验、通知必填 curl、前置判断组合规则）。
- **修复的死锁（两处）**：`scheduler::finish_run` 持锁调 `schedule_new_task`（第一次执行后调度器永久冻结）；`db::get_log_cleanup_preview` 持锁调 `get_log_storage_usage`。
- **修复的前端致命 bug**：`app.js` 顶层 `formatBytes` 重复声明——ES module 里是 SyntaxError，**整个前端不执行**（TS 版页面同样受害，PM2 里跑的旧进程没 reload 所以没发现）。
- 任务生命周期对齐：resume 恢复 stopped 任务（状态回 active + 清暂停）、stop 清暂停、暂停对 stopped 任务返回 400。
- 浏览器实测通过：页面加载/轮询、表单建任务（含通知）、立即执行（同步结果 + 命中 + 真实发通知）、执行记录、设置页（版本/自启/备份/对真实 Release 的升级检查）、测试台五步链、统计条、调度预览。

原来的五项：

1. **托盘** ✅：`jitter-app/src/tray.rs`，`tray-icon` + `muda`（仅 Windows 目标依赖），程序生成 32×32 RGBA 时钟占位图标，菜单「打开界面 / 退出」；独立线程跑 Win32 消息循环。**macOS/Linux 上托盘暂缺**（无原生事件循环可用，以纯服务形态发布），依赖只在 `cfg(windows)` 下引入，不影响三平台 CI。
2. **开机自启 / 退出 / 自动升级** ✅：`jitter-core/src/system.rs`（三平台纯文件写，与 TS `system.ts` 完全对齐）与 `jitter-core/src/updater.rs`（GitHub Releases 检查 / 下载 / zip 解压 / 自替换，Windows 走「等进程退出的辅助 cmd」）。退出经 `main.rs` 的 `quit_token()` 统一走优雅关停，托盘菜单与设置页共用。
3. **备份 / 导出 / 导入 / 恢复** ✅：`jitter-core/src/backup.rs` + `api.rs` 全部 `/api/backup/*` 路由（`VACUUM INTO`、路径穿越白名单、SQLite 头校验、恢复前安全快照、恢复后自动重启调度器）。注意 `axum` 的 body 上限已放宽到 256MB 以支持大库导入。
4. **GitHub Actions** ✅：`.github/workflows/ci.yml`（Rust core 双平台 + TS 参考测试）与 `.github/workflows/release.yml`（打 `v*` tag 触发；先跑两侧测试，再出 `jitter-windows-x64.zip` / `jitter-macos-arm64.zip` / `jitter-macos-x64.zip` / `jitter-linux-x64.zip` / `jitter-linux-arm64.zip` 五个资产并附 `.sha256`，资产名是升级逻辑的契约，不能改）。
5. **转正** ✅：README 已把 Rust 版标为发布物、TS 版标为参考实现。

---

## 九、环境坑（踩过的，别再踩）

### Windows 提交内存耗尽（最容易误判）

症状：

```
error[E0786]: found invalid metadata files for crate `xxx`
crate `xxx` required to be available in rlib format, but was not found
failed to mmap ... rlib: 页面文件太小，无法完成操作 (os error 1455)
target/debug/deps 目录整个消失
```

**这不是缓存坏了，也不是杀软**，是页面文件/提交内存不足导致 mmap 失败。解法：`CARGO_PROFILE_DEV_DEBUG=0` + `--jobs 1`。排查时先在完整错误里搜 `1455`。

### 数据库/配置是进程级单例

Rust 的 `db` 与 `config` 都是全局单例。**涉及它们的测试必须整段持锁**（不是只在初始化时持锁），否则并发测试会互相换掉全局连接，症状是 `UNIQUE constraint failed` 或 `FOREIGN KEY constraint failed`。

### 其它

- `include_str!` 路径按**文件所在目录**相对：`jitter-app/src/main.rs` 到 `src/frontend` 是 `../../../../src/frontend/`
- Bun 在本机非交互 shell 下 `node`/`npm` 可能找不到，跑 bun 前 `export PATH=...:<bun 目录>`
- 本机 bash 的 `cd` 钩子会打印一条 fnm 报错并返回非零码：**`cd X && cmd` 会被短路成失败**，必须写 `cd X; cmd`；cargo 全路径 `/c/Users/lhcz-fu/.cargo/bin/cargo.exe`
- `(... &)` 起的后台进程会随 shell 退出而死，跨调用要用工具的后台任务
- Elysia 收 octet-stream 时 body 可能是 `ArrayBuffer` 或 `Uint8Array`，两者都要接；客户端必须显式带 `Content-Type: application/octet-stream`
- `logs` 的 `*_options` 列是 `NOT NULL`，写 `"{}"` 而不是 `NULL`
- 后端单线程设计（TS 版）：任何可能长时间阻塞的操作都要分批（保留清理按 5000 行一批）
- Rust 升级检查的代理回退链：环境变量代理 → Windows 注册表系统代理（Clash 一类写的 `ProxyServer`）→ 直连；本机 curl/reqwest 不带 `-x` 直连不了 GitHub，`git` 走的是 `http.proxy=127.0.0.1:7897`

---

## 十、改动时的红线

1. **不要动 `src/frontend/` 的 API 契约**（路径、字段名、状态码）；改动前先看 Rust 版 `api.rs` 是否同步
2. **不要改 SQLite schema 而不加迁移**：只能 `ensure_column` 追加，不能改/删已有列
3. **改调度语义必须同时跑两边测试**：`bun test` 与 `cargo test -p jitter-core`
4. **改上传/恢复/清理这类破坏性接口**，先手动跑一遍"备份 → 改数据 → 恢复"回路
5. 提交前：`bun run typecheck && bun test`，Rust 侧 `cargo test -p jitter-core --jobs 1`
6. **持锁不要再锁**：`scheduler::state()` 与 `db` 的全局 Mutex 都不可重入——任何"锁内调用另一个会拿锁的函数"都会自死锁（v1.0.0 之前 `finish_run` 和 `get_log_cleanup_preview` 各有一处，症状是接口无响应挂起）。前端是 ES module：**同名顶层函数重复声明是 SyntaxError，整个 app.js 不会执行**（症状是页面纯静态、无任何 /api 请求），改前端后务必在浏览器里真实打开一次页面。

---

## 十一、发布怎么打

```bash
# 提交 + 推送（CI 会跑两侧测试）
git push

# 打 tag 触发 Release 工作流（等 Actions 出完资产即可下载）
git tag v1.0.1 && git push origin v1.0.1
```

升级逻辑按资产名找当前平台的 zip（`jitter-<platform>-<arch>.zip`），所以资产名是契约。**新版本的 tag 必须大于二进制里的 `CARGO_PKG_VERSION`（workspace version）才会被判定为可升级**：发布前把 `rust/Cargo.toml` 的 `workspace.package.version` 与 `package.json` 一起 bump，再打对应 tag。

老用户迁移（例如从 PM2 管理的 TS 版）：停掉旧进程 → 下载 zip 解压运行新版 → 网页「设置 → 备份与恢复」上传旧库备份（或直接用旧 `data/app.db` 的备份）→ 点「恢复」→ 勾选「开机自启」。

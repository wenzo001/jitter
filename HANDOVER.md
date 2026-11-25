# Jitter 交接说明（维护者用）

> 最后更新：2026-11-25 · v2.1.9 · 单主线（Rust 后端 + Vue 前端）
> 面向用户的使用说明在 [README.md](README.md)，两者不要各写各的。

---

## 一、一句话现状

Jitter 是一个常驻本机的定时 HTTP 请求工具：粘 curl → 定时间 → 到点自动发 → 判定成功 → 可选再发一条通知 curl。
**仓库只有一条代码线**：Rust 后端（axum + tokio + rusqlite）+ Vue 3 前端（`web/`），
前端产物通过 `include_dir!` 嵌进二进制，发布出来是单文件程序。

早期那条 Bun/TypeScript 后端（根目录 `src/`、`bun.lock`、`tsconfig.json`、`ecosystem.config.cjs`）已**彻底删除**，
Dockerfile / CI / 发布流水线都走 Rust 主线。不要把它捡回来。

**当前版本：v2.1.9。** 工作区改动都已提交在 `main` 上，发布走 `v*` 标签。
接手第一件事：跑一遍第五节的构建与测试，确认基线是绿的，再决定要不要提交。

---

## 二、目录地图

```
rust/
  crates/jitter-core/   纯逻辑库（无 HTTP、无 UI），可单测
    config.rs           配置：内置默认 < 配置文件 < 环境变量
    db.rs               SQLite schema / CRUD / 保留清理 / 只读浏览
    schedule.rs         调度模型（daily 窗口 / 精确时间±抖动 / interval）
    window.rs           跨午夜窗口、暂停区间
    guard.rs            本地条件（星期 / 时段 / 工作日）
    condition.rs        表达式求值器（受限的类 JS，不执行任意代码）
    curl_parser.rs      curl 命令解析
    executor.rs         传输层 + 前置判断 + 判定 + 通知（含连接重置重试）
    holiday.rs          中国法定节假日（含调休上班日）
    logging.rs          运行日志落盘 / 按天轮转 / 清理
    backup.rs / updater.rs / host.rs / system.rs / testbench.rs / metrics
  crates/jitter-app/    可执行程序
    main.rs             启动顺序、panic 兜底、启动失败弹窗、tracing 初始化
    api.rs              全部 HTTP 路由
    scheduler.rs        调度器（定时器 + 执行编排）
    tray.rs             Windows 托盘（macOS / Linux 为空实现）
web/                   前端（Vue 3 + TS + antdv-next + Vite + Pinia + vue-i18n + vueuse）
  src/api/              请求封装（client.ts 是统一入口）
  src/components/       组件
  src/stores/           Pinia（app / tasks / logs / diagnostics）
  src/locales/          zh-CN / en-US 文案
  tests/                vitest 单测
```

---

## 三、不能随便碰的约定

1. **接口路径与 JSON 字段是契约**。前端 `web/src/api/*.ts` 与后端 `rust/crates/jitter-app/src/api.rs` 必须一一对应，
   `web/src/types/*.ts` 是类型侧的同一份契约。改任何 `/api/*` 路径或字段名，三处一起改。
2. **`web/dist` 会被编译进二进制**。改前端后必须先 `cd web && bun run build`，再 `cargo build`。
3. **release profile 是 `panic = "unwind"`**，不是 abort。abort 会让任意一处 panic 直接杀掉整个进程；
   unwind 之后单个请求里的 panic 只结束那一次连接。这条不要改回去。
4. **数据库只读浏览是严格只读的**。`list_database_rows` 的表名必须命中白名单，否则 400。不要为了方便放开。
5. **手动执行跳过执行条件**。`executor.rs` 里 `RunSource::Manual` 会跳过所有前置判断。这是有意设计，
   改之前先确认 UI 文案同步。
6. **节假日判定在服务端**。前端不重复实现节假日语义，一切以 `/api/system/holiday*` 为准。
7. **日志按本地日期轮转**（`jitter-YYYY-MM-DD.log`，保留 14 天，`JITTER_LOG_DAYS` 可调）。
   **不要换成 `tracing-appender`**：它按 UTC 换文件，国内用户早上 8 点就"昨天的日志"跑到今天去了。
8. **相对 `dbPath` 的基准是「配置文件目录 → exe 目录 → CWD」，不是 CWD**（`config.rs` 的 `base_dir_for` /
   `resolve_db_path_absolute`）。这条是为了避免"在仓库根目录跑开发版，把用户正式库 `data/app.db` 直接写坏"。
   仓库根 `jitter.config.json` 是**开发/容器默认配置**：`port` 3111、`dbPath` `.tmp/dev/app.db`，
   改它之前先确认 Docker 的 `PORT` / `JITTER_DB_PATH` 环境变量没被绕过。

---

## 四、踩过的坑（别再踩一遍）

### 4.1 Windows 上 `append(true)` 打开的文件，目录项里的大小是 0
只开 `FILE_APPEND_DATA` 权限时，Windows 要等句柄关闭才更新目录项里的文件大小，
于是「运行日志」面板读到的文件大小一直是 0 字节。
**修法**：打开日志文件时同时给 `.write(true)`；`list_files` 用 `fs::metadata(path)` 而不是 `DirEntry::metadata()`。

### 4.2 `panic = "abort"` 会让整个进程死掉
一次请求里的 panic 直接杀掉服务，用户看到的是「程序没了」。改成 unwind 后单请求失败不影响其它功能，
再配合 `main.rs` 的 panic hook（落盘 + stderr）和启动失败弹窗，异常才看得见、救得回来。

### 4.3 Windows 发布版没有控制台
`#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]`。
发布版里日志文件是**唯一**的线索，所以 `init_tracing` 必须同时写控制台和文件，文件写失败也不能影响启动。

### 4.4 本机编译会 os error 1455
Windows 页面文件不够。编译前设 `CARGO_PROFILE_DEV_DEBUG=0`，并用 `--jobs 1`。

### 4.5 只有一个实例能跑
`acquire_single_instance()` 抢命名互斥体。要同时跑两个实例时设 `JITTER_ALLOW_MULTI_INSTANCE=1`。
互斥体句柄是 `isize`（Copy 类型），`mem::forget` 对它没作用——**不关闭句柄**才是让它活到进程结束的关键。

### 4.6 vue-i18n 的文案里不能出现裸的 `|`
vue-i18n 消息语法把 `|` 当复数分隔符。文案里写逻辑或 `||` 会在**编译期**抛
`SyntaxError: Plural must have messages`（@intlify 错误码 11），用到那条文案的组件直接渲染失败。
**症状极其隐蔽**：只有在切换语言、真正渲染到那条文案时才炸，页面看起来还挺正常。
**修法**：文案里不写裸 `|`（改用"逻辑或"这种文字）。
**防回归**：`web/tests/i18n-compile.test.ts` 用 `@intlify/message-compiler` 把两份文案逐条编译一遍，改文案后必须跑。

### 4.7 vueuse 的 `useIntervalFn` 默认 `immediate: true`
写 `{ immediate: false }` 会让**定时器根本不启动**（`if (immediate && isClient) resume()`）。
`stores/diagnostics.ts` 的健康轮询曾经这么写，结果「后台没响应」横幅永远不会出现——
用户看到的是界面卡在旧数据上，没有任何提示。
**防回归**：`web/tests/diagnostics.test.ts` 里用 fake timers 断言轮询真的在跑。

### 4.8 Vue 模板里的空格会被折叠
`<span>{{ label }} </span>{{ value }}` 渲染出来是 `labelvalue`。要间距就用 CSS margin 或 `&nbsp;`，
别指望模板里的空格。

### 4.9 手工 vite codeSplitting 会造成循环依赖
手动拆 antd / vue chunk 后运行时报 `TypeError: nt is not a constructor`。
字节数与自动分包相同，已放弃手工分包。**别再试。**

### 4.10 `tracing_subscriber` 的 `Filter` trait 路径
`tracing_subscriber::filter::Filter` 不存在，正确是 `tracing_subscriber::layer::Filter`；
`enabled` 的第二个参数是 `Context`（不是 `&Context`）。

### 4.11 配置文件坏了不等于要换数据库
相对 `dbPath` 的基准是「配置文件目录 → exe 目录 → CWD」。
如果配置文件解析失败时把基准退回 exe 目录，用户自定义的 `dbPath` 就被丢掉了，
程序会拿默认的 `data/app.db` 指向另一个库——界面看上去"任务全没了"。
**规则**：只要找到了配置文件，基准目录就按它算，跟配置内容读没读出来无关。
**防回归**：`main.rs` 的 `a_broken_config_keeps_its_own_directory_as_the_data_base`。

### 4.12 4xx 不等于"后台故障"
接口 400/404（查一张刚被删掉的表、翻页游标坏了）是请求本身的问题，
把它记进 `LAST_ERROR` 会让界面永久挂着"后台降级"横幅。
**规则**：只有 5xx 才算后台故障；4xx 只写日志。
**防回归**：`api.rs` 的 `only_server_errors_mark_the_service_as_degraded`。

### 4.13 按字节分页读日志会切碎中文
`read_file` 按字节偏移读，`String::from_utf8_lossy` 会把被切断的中文字变成 `�`。
**修法**：读完先算出"完整字符前缀"，残缺的那几个字节留给下一段（`next_offset` 只算完整部分）。
**防回归**：`logging.rs` 的 `utf8_prefix_keeps_only_complete_characters`。

---

## 五、构建与测试

```bash
# 前端
cd web && bun install && bun run typecheck && bun run test && bun run build

# 后端
cd rust && cargo test -p jitter-core --jobs 1
cd rust && cargo check --workspace --all-targets --jobs 1
cd rust && cargo build --release -p jitter-app --jobs 1
```

Windows 本机编译务必 `set CARGO_PROFILE_DEV_DEBUG=0`，否则会 os error 1455。

**改动落点与对应测试**：

| 改动 | 必须跑的测试 |
| --- | --- |
| `rust/crates/jitter-core/**` | `cargo test -p jitter-core --jobs 1` |
| `web/src/**` | `cd web && bun run typecheck && bun run test` |
| `web/src/locales/**` | 必须包含 `bun run test`（i18n-compile 用例会逐条编译文案） |
| `web/src/**` 界面相关 | 改完还要开浏览器实测（见下） |
| 接口路径 / 字段 | 前后端一起改，并同步 `web/src/types/*` |

### 界面回归怎么测

起一个**副本实例**（绝不能动用户自己的 `data/app.db`）：

```bash
# 1) 复制真实库并把任务置为 stopped，避免真的发请求
cd D:/fwd/code/Jitter
bun .tmp/preview/prepare.js      # VACUUM INTO '.tmp/preview/app.db' + tasks.status='stopped'

# 2) 用副本配置启动（端口 3111）
#    JITTER_CONFIG=.tmp/preview/jitter.config.json
#    JITTER_ALLOW_MULTI_INSTANCE=1   （用户自己的实例在跑，不设会被单实例锁拦下）
#    JITTER_DB_PATH=.tmp/preview/app.db
#    & rust/target/debug/jitter.exe
```

然后用内置浏览器打开 `http://127.0.0.1:3111` 逐个点：顶栏时钟 / 日历 / 数据库 / 运行日志 / 诊断 / 设置 /
任务表单 / 试跑 curl / 任务卡「更多」/「立即执行」，
最后用浏览器控制台查询（console kind）确认没有 error。

> 用户自己还有一个真实实例在跑：`D:\下载\Compressed\jitter.exe`（端口 3000/3001）。
> **不要擅自重启它**，需要时先问用户。

---

## 六、本轮已经做完的事（可以直接接手）

**后端健壮性**
- panic 兜底：`panic = "unwind"` + `main.rs` 的 panic hook 落盘 + 启动失败弹 `MessageBoxW`。
- `/api/health` 扩展：version / uptimeMs / dbOk / dbPath / logDir / lastError。
- 错误响应带 `hint` 字段，前端能直接显示「下一步该做什么」。
- 新增 `/api/system/logs` 与 `/api/system/logs/:name`，前端「运行日志」面板可读、可复制。
- 运行日志按本地日期落盘轮转，保留 14 天。
- `executor.rs` 补齐了「连接被重置自动重试」（之前只是死常量 + README 吹牛），含 3 个单测。

**前端健壮性**
- `api/client.ts` 重写：`ApiError`、错误分类、GET 自动重试 2 次、默认 hint。
- `stores/diagnostics.ts`：全局异常收集（上限 60 条）、服务状态 ok/degraded/down、诊断报告。
- `main.ts`：`app.config.errorHandler` + `unhandledrejection` + `error` 全局捕获，并 `console.error` 打完整堆栈。
- `ErrorBoundary.vue` / `DiagnosticsDialog.vue` / `RuntimeLogsDialog.vue`：错误边界、诊断面板、运行日志面板。
- `App.vue`：后台无响应横幅（重新检测 / 查看运行日志）、主界面错误边界包裹。

**国际化 / 依赖**
- vue-i18n 11 接入，678 条文案中英各一份，`MessageSchema = typeof zhCN` 保证 key 一致。
- 顶栏 `a-segmented` 切换语言，立即生效 + localStorage 持久化 + 同步 `<html lang>`，antdv-next locale 同步。
- **后端返回的动态数据不翻译**（任务名、schedule_description、日志内容、后端错误文本），这是有意约定。
- vueuse 14 接入：剪贴板、localStorage、定时器、可见性都用 vueuse，不再手写。
- RUST_LOG 回到标准 `tracing_subscriber::EnvFilter`（自写 LogFilter 已删）。

**本轮修掉的三个真 bug**
1. vue-i18n 文案里的 `||` 触发编译崩溃（见 4.6）。
2. vueuse `useIntervalFn({ immediate: false })` 导致「后台没响应」检测从未生效（见 4.7）。
3. 任务卡 `Schedule每天 …` 少一个分隔符（模板空格被折叠，见 4.8）。

**其它**：README 重写为用户使用文档；Bun/TS 旧代码线彻底删除；CI 门禁加上 `bun run test`；
Dockerfile 改成三阶段 Rust 主线；cargo 警告清零（`cargo check --workspace --all-targets` 0 warning）。

---

## 七、还没做完的事（接手从这里开始）

1. **决定要不要提交**：目前全部未提交，改动量很大（30+ 文件）。
2. **用户自己的实例需要更新**：新功能要 `cargo build --release` 后重启 `D:\下载\Compressed\jitter.exe` 才生效，
   **必须先问用户**再动。
3. **未实跑验证的**：`docker build`（本机没有 docker 命令），Dockerfile 改动后没跑过。

## 七之二、本轮最终状态（已实测）

**测试**

| 项目 | 结果 |
| --- | --- |
| `cargo test -p jitter-core --jobs 1` | **241 项全绿** |
| `cargo check --workspace --all-targets --jobs 1` | **0 warning / 0 error** |
| `bun run typecheck` | 退出码 0 |
| `bun run test` | **5 文件 / 57 用例全绿** |
| 浏览器实测（副本实例 3111） | 页面 0 console error / 0 warn |

**发布体积（2026-11-25 实测）**

| 项 | 大小 |
| --- | --- |
| `rust/target/release/jitter.exe` | **7,584,256 B（7.23 MB）** |
| zip（deflate-6） | **3,169,860 B（3.02 MB）**，CI 的 `zip -9` 还会再小一点 |
| `web/dist/assets/index-*.js` | 1,687,282 B（gzip 465 KB） |
| `web/dist/assets/index-*.css` | 20,944 B |

> 对比本轮开工前（7,446,528 B / zip 3.07 MB）：**整体更小了**。
> 拆解：i18n 让前端 +135 KB 原始体积，但压缩率高，zip 反而小了；
> 标准 `EnvFilter` 比自写 `LogFilter` 大约 265 KB（3.7%），换来标准 `RUST_LOG` 语义
> （级别 + 目标前缀 + span），按「能用开源就用开源，体积不受影响就用开源」保留。
> release profile 已是 `opt-level="z" + lto + codegen-units=1 + strip=true`，没有进一步空间。

**界面实测结论**
- 顶栏在窄窗口下是「第一行品牌 + 时钟 / 第二行整排按钮」两段式，不再从按钮中间断开。
- 左右两块面板等高填满，各自内部滚动，不再一边留白。
- 执行记录面板头：标题 + 副信息归一段，按钮整组换行，不会只掉下一个「刷新」。


---

## 八、发布

- 打 `v*` 标签触发 `.github/workflows/release.yml`。
- **资产名必须保持 `jitter-<platform>-<arch>.zip`**（platform ∈ windows/macos/linux，arch ∈ x64/arm64），
  内置升级逻辑按这个名字找包，改名会让升级找不到。
- 包内只有 `jitter.exe`（Windows）或 `jitter`（其它平台），同时发布同名 `.sha256`。
- 五个平台：windows-x64、macos-arm64、macos-x64、linux-x64、linux-arm64。
- `Dockerfile` 是三阶段（前端 → Rust 构建 → debian-slim 运行），别把 `rust/target` 拷进构建上下文（本地有十几 GB）。
- 本机没有 docker 命令，Dockerfile 改动后未实跑验证过。

---

## 九、文档同步约定

- **README.md 面向用户**（怎么用、怎么排查、怎么升级），**本文面向维护者**（架构与约定）。
- 改动命令、路径、字段名、环境变量、配置项时，两份文档都要核对。
- 文档里不写「以后补」这类空洞句子；拿不准就去读代码。

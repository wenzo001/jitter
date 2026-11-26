# Jitter 交接说明（维护者用）

> 最后更新：2026-11-26 · v2.1.18 · 单主线（Rust 后端 + Vue 前端）
> 面向用户的使用说明在 [README.md](README.md)，两者不要各写各的。

---

## 一、一句话现状

Jitter 是一个常驻本机的定时 HTTP 请求工具：粘 curl → 定时间 → 到点自动发 → 判定成功 → 可选再发一条通知 curl。
**仓库只有一条代码线**：Rust 后端（axum + tokio + rusqlite）+ Vue 3 前端（`web/`），
前端产物通过 `include_dir!` 嵌进二进制，发布出来是单文件程序。

早期那条 Bun/TypeScript 后端（根目录 `src/`、`bun.lock`、`tsconfig.json`、`ecosystem.config.cjs`）已**彻底删除**，
Dockerfile / CI / 发布流水线都走 Rust 主线。不要把它捡回来。

**当前版本：v2.1.18（已发布）**，Release：<https://github.com/wenzo001/jitter/releases/tag/v2.1.18>。
发布走 `v*` 标签，标签打在哪一版 README 里就写哪一版。
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
    instance.rs          实例隔离：实例名 → 配置目录 / 自启项 / 互斥体名
    probe.rs             只读探针（SQLITE_OPEN_READ_ONLY 打开生产库读数据）
  crates/jitter-app/    可执行程序
    main.rs             启动顺序、panic 兜底、启动失败弹窗、tracing 初始化、probe 分流
    api.rs              全部 HTTP 路由
    scheduler.rs        调度器（定时器 + 执行编排）
    tray.rs             Windows 托盘（macOS / Linux 为空实现）
    probe_cli.rs        `jitter probe` 子命令（只读查生产库）
scripts/                dev-instance.ps1：起隔离开发实例
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
9. **生产实例的路径必须与旧版逐字节相同**（`instance.rs` 里 `DEFAULT_INSTANCE = "prod"`）：
   配置目录仍叫 `Jitter`、自启项仍叫 `Jitter.cmd`。升级不能动用户已有的设置与自启注册。
10. **只读探针必须用连接层的只读标志**（`SQLITE_OPEN_READ_ONLY`），
    不是「代码里不写 INSERT」。后者拦不住误操作，前者从连接上就拒绝写。
11. **不要用 `JITTER_ALLOW_MULTI_INSTANCE=1` 起开发实例**：那只绕过互斥体，
    隔离不了 runtime 文件和开机自启注册项，会直接破坏用户正式实例。走 `scripts\dev-instance.ps1`。

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

### 4.14 dayjs 默认是英文，vue-i18n 切中文不会带上它
dayjs 的语言包**要单独注册**，而且注册 ≠ 切换：`import 'dayjs/locale/zh-cn'` 只是把语言包装进去，
还得 `dayjs.locale('zh-cn')` 才会真的用它。
本项目只注册语言包、不改全局 locale（`web/src/i18n.ts`），因为界面语言由 vue-i18n 管，
dayjs 只在「日历弹窗」里被用到（antd 的 `a-calendar` 会按 locale 自己设 dayjs 的语言，
所以英文界面下日历仍然是英文月份）。
**症状**：界面全中文，但日历里的月份是 `Jan Feb Mar`、星期是 `Su Mo Tu`。
**防回归**：改日历或日期格式化时，确认 `zh-cn` 语言包还在 `i18n.ts` 的 import 里。

### 4.15 antdv-next 的 `a-dropdown` 不支持 `#overlay` 插槽
写 `<template #overlay>` 会被 vue-tsc 报 `Property 'overlay' does not exist`。
**正确写法**：`:menu="menuProps"` + 在 menu 上挂 `onClick` 分发（参考 `App.vue` 的 `moreMenu`）。
antdv-next 的 `Menu` 也没有 `selectedKeys` prop，想标出「当前语言」只能在 label 里自己加 `✓`。

### 4.16 自动化脚本里匹配 antd 按钮要先去空格
antd 会把两个中文字之间自动插一个空格（「更多」渲染成 `更 多」）。
脚本里按文本找按钮时用 `textContent.replace(/\s/g, '')` 再比。
另外 **Dropdown / Modal 的触发器必须用真实 `page.mouse.click(x, y)`**，`el.click()` 或 `dispatchEvent` 不会打开
（普通按钮用 `el.click()` 倒是能触发 Vue 的 `@click`）。

### 4.17 日历的星期表头默认右对齐
antd 的 `th` 是 `text-align: end`，而 `fullCellRender` 里我们把日期数字放在格子左边，
两者不对齐，看起来就是「周几往右歪」。
**修法**：`CalendarDialog.vue` 里 `.cal-panel :deep(.ant-picker-panel .ant-picker-body thead th) { text-align: left; padding: 0 6px 4px 7px; }`，
内边距跟 `.cal-cell`（1px 边框 + 6px padding）对上。
注意选择器要比 antd 的 `.ant-picker-calendar.ant-picker-calendar-full .ant-picker-panel .ant-picker-body th`（0,4,1）更具体才盖得住。

### 4.18 antd 日历的「年」视图跟 fullCellRender 不兼容
`fullCellRender` 是按「一个月里的每一天」写的，切到整年网格后每个格子都会渲染错（只剩一堆乱码）。
**规则**：这个日历只需要按月看，把 antd 的视图切换藏掉：
`.cal-panel :deep(.ant-picker-calendar-mode-switch) { display: none; }`。
年份/月份的选择器（`.ant-picker-calendar-year-select` / `-month-select`）保留，还能换年月。

### 4.19 highlight.js 要按需注册语言，不要全量引入
`import hljs from 'highlight.js'` 会把全部 ~190 种语言打进包里。
**正确写法**：`import hljs from 'highlight.js/lib/core'` + 逐个 `registerLanguage`
（json / bash / xml / sql / yaml / javascript / python / powershell / ini / dockerfile），
再 `import 'highlight.js/styles/github.css'` 取配色（包内没有独立 css 文件，主题在 `styles/` 目录）。
主题类是 `.hljs-*`，跟组件 scoped 样式冲突时要用 `:deep()` 并把选择器写具体一点。

### 4.20 判断「连着网」不能只看有没有 IPv4
虚拟网卡（VMware / Hyper-V / vEthernet / WSL / Docker / 蓝牙 / VPN / 隧道）几乎总是带 IPv4 地址，
只看「有没有地址」会让「已连接网络」这个条件**永远成立**，等于没加。
**正确口径**：适配器 Up + 类型是物理网卡 + 拿到可用 IPv4（排除 `0.0.0.0` / `127.*` / `169.254.*`）+ 名字不含虚拟网卡关键字。
Windows 上类型看 `IP_ADAPTER_ADDRESSES_LH::IfType`：6 = 以太网，71 = IEEE 802.11（WiFi）；
**windows-sys 0.59 没有 `IF_TYPE_*` 常量**，得自己定义（`host.rs` 里的 `IF_TYPE_ETHERNET` / `IF_TYPE_IEEE80211`）。
Linux 上类型看 `/sys/class/net/<name>/type`（1 = 以太网）和 `wireless` 目录；macOS 有线无线都叫 `en*`，只能判断「有没有连上」。

### 4.21 执行条件之间是「与」，单个条件内部是「或」
多个执行条件同时启用时必须**全部满足**才执行（后端 `evaluate_local_guard` / `evaluate_host_guard` / 前置 curl
在 `executor.rs` 与 `testbench.rs` 里都是任一失败即 early return）。
但**一个条件内部的多值是「或」**：星期多选、本机 IP 多模式、WiFi / 网线二选一都属于该条件自身的备选。
前端文案也按这个口径写（`condition.conjunctionHint` / `condition.badgeNote`），不要改成含糊的「满足其一」。

### 4.22 跨平台断言别写死目录名

v2.1.18 第一次发 CI 时挂在 `ubuntu-latest`：`instance` 的单测断言
「生产配置目录名包含 `Jitter`」——**Linux 上是 `$XDG_CONFIG_HOME/jitter`（小写）**，Windows / macOS 才是 `Jitter`。

写死字面量的断言只在本机（Windows）绿，CI 上才炸。正确写法是断言**语义**：
「生产目录名 == 平台默认目录名」（`instance::base_config_dir_name()`），
而不是断言它等于某个字符串。

> 顺带记住：**本机测试全绿 ≠ CI 会绿**。CI 里跑 `cargo test -p jitter-core`（含跨平台集成测试），
> 改动路径、目录名、平台分支时要想一遍另外两个平台。

### 4.23 Windows 发布版是 GUI 子系统程序，probe 的输出行为和别的程序不一样

`main.rs` 顶上那行 `#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]`
是为了双击 exe 不弹黑窗口。代价是**发布版的 `jitter.exe` 是 GUI 子系统程序**：

- 直接在终端跑 `jitter.exe probe ...`：**输出正常显示**（stdout 句柄继承自父进程，写入有效）；
- 重定向到文件 `jitter.exe probe ... > probe.txt`：**完整写入**（实测 1698 B，exit=0）；
- 但 `$x = & jitter.exe probe ...` 这种**捕获到变量**的写法拿不到任何东西——
  PowerShell 对 GUI 子系统程序不等待、也不接管它的输出。

排查时要么直接看屏幕，要么重定向到文件。别在脚本里指望 `$(...)` 捕获。
Rust 侧的 `stdout.is_terminal()` 在 GUI 程序里也会返回 `false`（没 AttachConsole），
别拿它判断「输出到哪去了」。

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

起一个**隔离开发实例**（绝不能动用户自己的 `data/app.db`）：

```powershell
# v2.1.18 起：一律用这个脚本（实例名 dev，端口 3111，库在 .tmp\dev\app.db）
cd D:/fwd/code/Jitter
.\scripts\dev-instance.ps1
```

想看真实数据（但**只读**）就另开一个探针，不要把生产库挂到跑着的实例上：

```powershell
.\rust\target\release\jitter.exe probe --db "D:\下载\Compressed\data\app.db" `
    --logs "D:\下载\Compressed\data\logs" --limit 20
```

> ⚠️ v2.1.17 之前那段手工设 `JITTER_ALLOW_MULTI_INSTANCE=1` + `JITTER_CONFIG` / `JITTER_DB_PATH`
> 的做法**已经不要再用**：那些全局共享状态（runtime 文件、开机自启注册项、互斥体）当时都是共用的，
> 手工起实例会直接踩到用户的正式实例（尤其会把正式实例的 `Startup\Jitter.cmd` 覆盖成开发版路径）。

然后用内置浏览器打开 `http://127.0.0.1:3111` 逐个点：顶栏时钟 / 日历 / 数据库 / 运行日志 / 诊断 / 设置 /
任务表单 / 试跑 curl / 任务卡「更多」/「立即执行」，
最后用浏览器控制台查询（console kind）确认没有 error。

> 用户自己还有一个真实实例在跑：`D:\下载\Compressed\jitter.exe`（端口 3000/3001）。
> **不要擅自重启它**，需要时先问用户。

### ⚠️ 起开发实例一律用 `scripts\dev-instance.ps1`（v2.1.18 起）

```powershell
.\scripts\dev-instance.ps1                    # 实例名 dev，端口 3111，库 .tmp\dev\app.db
.\scripts\dev-instance.ps1 -Instance test -Port 3112
```

**不要再手动设 `JITTER_ALLOW_MULTI_INSTANCE=1` 起开发实例**——v2.1.18 之前那些全局共享状态
（runtime 文件、开机自启注册项、互斥体）都是共用的，手工起实例会踩到用户正式实例：

- 开发实例退出时把 `%APPDATA%\Jitter\jitter.runtime.json` 删掉 → 正式实例的端口记录没了；
- **开发实例在设置里点一次「开机自启」，就把正式实例的 `Startup\Jitter.cmd` 覆盖成开发版路径**
  → 用户开机自启会跑开发版，且界面上完全看不出来。

现在 `JITTER_INSTANCE` 把这些按实例隔开了（详见 `rust/crates/jitter-core/src/instance.rs`）：

| 共享状态 | 生产（`prod`） | 开发（`dev`） |
| --- | --- | --- |
| 配置 / 运行时文件 | `%APPDATA%\Jitter\` | `%APPDATA%\Jitter-dev\` |
| 开机自启注册项 | `Startup\Jitter.cmd` | `Startup\Jitter-dev.cmd` |
| 单实例互斥体 | `Local\JitterSingleInstance-prod` | `Local\JitterSingleInstance-dev` |

**生产实例的路径与升级前逐字节相同**（配置目录仍叫 `Jitter`、自启项仍叫 `Jitter.cmd`），
升级不会动到用户已有的设置。唯一变化是互斥体名统一加了 `-prod` 后缀——
这样「每个实例各自互斥、实例之间互不干扰」才自洽。

### 只读看生产数据：`jitter probe`（v2.1.18 起）

```powershell
& rust\target\release\jitter.exe probe --db "D:\下载\Compressed\data\app.db" `
    --logs "D:\下载\Compressed\data\logs" --limit 20
```

只读打开（`SQLITE_OPEN_READ_ONLY`），输出任务列表、设置、最近执行记录、运行日志尾部。
**不会修改** `app.db` / `app.db-wal` / `app.db-shm`（连 mtime 都不变），正式实例可以照常在跑。
实现见 `rust/crates/jitter-core/src/probe.rs` 与 `rust/crates/jitter-app/src/probe_cli.rs`。

---

## 六、本轮已经做完的事（可以直接接手）

### 6.0.7 v2.1.18：实例隔离 + 只读探针（`jitter probe`）

用户需求：开发测试用的实例要和正式实例**完全分开、互不影响**，并且开发者要能**只读**查看生产数据来排查问题。

**问题根因**：旧版假设「一台机器只有一个实例」，三类全局状态写死在同一个地方，
开发实例一碰就会破坏正式实例：

| 共享状态 | 旧路径 | 旧版冲突后果 |
| --- | --- | --- |
| 配置 / 运行时文件 | `%APPDATA%\Jitter\jitter.runtime.json` | 开发实例覆盖正式实例的端口记录；开发实例退出时把它删掉 |
| 开机自启注册 | `Startup\Jitter.cmd` | **开发实例点一次「开机自启」，就把正式实例的注册覆盖成开发版路径**，界面上完全看不出来 |
| 单实例互斥体 | `Local\JitterSingleInstance` | 开发实例只能靠 `JITTER_ALLOW_MULTI_INSTANCE=1` 绕过，多开就乱 |

**解法**：用环境变量 `JITTER_INSTANCE` 声明实例名（默认 `prod`），把上面三类状态全部按实例派生。

| 改动 | 落点 |
| --- | --- |
| 新增实例模块：实例名规范化 + 配置目录 / 运行时文件 / 自启文件名 / 互斥体名派生 | `rust/crates/jitter-core/src/instance.rs`（新增） |
| 配置目录改为按实例派生（生产仍是 `%APPDATA%\Jitter`） | `system.rs`（`get_config_dir`） |
| 自启注册项按实例命名（Windows `Jitter.cmd` / `Jitter-dev.cmd`；macOS `com.jitter.app.plist` / `com.jitter-dev.app.plist`；Linux `jitter.desktop` / `jitter-dev.desktop`） | `system.rs`（`build_autostart_entry_for`） |
| 互斥体名按实例派生（`Local\JitterSingleInstance-prod` / `-dev`） | `rust/crates/jitter-app/src/main.rs` |
| `SystemInfo` 增加 `instance` / `default_instance` 字段 | `system.rs`、`api.rs` |
| 只读探针核心：`SQLITE_OPEN_READ_ONLY` 打开 + 读任务 / 设置 / 最近记录 / 运行日志尾部（表名走白名单防注入） | `rust/crates/jitter-core/src/probe.rs`（新增） |
| 新增 `probe` CLI 子命令（**在 `main()` 最开头分流**：不起服务、不占端口、不抢互斥体、不初始化自己的数据库） | `rust/crates/jitter-app/src/probe_cli.rs`（新增） |
| 顶栏显示实例标记（仅非默认实例显示橙色「实例 dev」） | `web/src/App.vue`、`web/src/styles.css`、`web/src/stores/app.ts` |
| 设置页「运行信息」增加「实例」行 | `web/src/components/dialogs/SettingsDialog.vue`、`web/src/types/system.ts` |
| 一键起隔离开发实例的脚本 | `scripts/dev-instance.ps1`（新增） |
| 集成测试：自启项按实例隔离、生产路径与旧版逐字节一致、互斥体名按实例隔离 | `rust/crates/jitter-core/tests/system_updater.rs`（新增 3 个） |
| 前端单测：实例标记的显示条件 | `web/tests/instance-badge.test.ts`（新增） |

**约定**：
- **生产实例的路径必须与旧版逐字节相同**（配置目录仍叫 `Jitter`、自启项仍叫 `Jitter.cmd`），
  升级不动用户已有设置。唯一的行为变化是互斥体名统一加了 `-prod` 后缀——
  这是有意的：生产沿用旧名而开发用新名的话，「按实例互斥」不自洽。
- 实例名规范化：只保留字母数字 / `-` / `_`，其它字符换成 `-`，截断 32 字符，全非法回落 `prod`
  （绝不能变成空名字，否则路径会塌回生产目录）。
- **只读必须做在连接层**（`SQLITE_OPEN_READ_ONLY`），不是「代码里不写 INSERT」——
  后者拦不住误操作，前者从连接上就拒绝写。
- 探针**不能起服务**：它在 `main()` 最开头分流，避免占端口、抢互斥体、
  甚至初始化自己的数据库把生产库当自己的写。
- 开发实例一律用 `scripts\dev-instance.ps1` 起，不要再手工设 `JITTER_ALLOW_MULTI_INSTANCE=1`
  （那只绕过了互斥体，隔离不了 runtime 文件和自启注册）。

### 6.0.6 v2.1.17：日志清理分层 + 每个任务单独设保留时长

用户需求（三条）：
1. 选中某个任务后点「清理日志」→ 清理的是**该单个任务**的日志；
2. 设置里可以**清理全部任务**的日志；
3. 支持**每个任务单独设置日志保留时长**（某任务只留 1 天，某任务留一个月甚至更久），
   并且清理 / 保留的交互要清晰，让用户知道怎么操作。

| 改动 | 落点 |
| --- | --- |
| `tasks` 表新增 `log_retention_days INTEGER`（只走迁移 `ensure_column`，NULL = 跟随全局，0 = 永久） | `rust/crates/jitter-core/src/db.rs`（`TaskRow` / `NewTaskInput` / `TaskColumns` / INSERT `?41` / UPDATE `?41`） |
| 保留清理**逐任务**按有效天数删：任务自定义优先于全局，0 = 永久保留 | `db.rs`（`prune_logs`） |
| 清理预检 / 清理支持按任务范围（`task_id` 可选）；`all:true` + `task_id` = 清空该任务全部日志 | `db.rs`（`count_logs` / `get_log_cleanup_preview` / `cleanup_logs`）、`api.rs`（`/api/logs/cleanup`） |
| 清理范围 id 一律走**参数化** SQL（`count_logs` 改写为 `Vec<Box<dyn ToSql>>` + `params_from_iter`，不再拼 where 子句） | `db.rs` |
| API 解析任务级 `log_retention_days`（null/缺省 = None；数字须 0..=3650，否则 400） | `api.rs` |
| **查询窗口也按任务算**：任务自设的保留期决定这条任务能看到多旧的记录（否则设了 30 天却只显示全局 10 天） | `api.rs`（`list_logs`） |
| 任务表单新增第 5 段「日志保留」：跟随全局设置 / 保留 N 天 / 永久保留 | `web/src/components/task/TaskForm.vue`、`web/src/utils/log-retention.ts`（新增） |
| 清理弹窗加「清理范围」切换（只清这个任务 / 清理全部任务），顶部用 alert 明示当前范围，切换范围重拉预检 | `web/src/components/dialogs/CleanupLogsDialog.vue`、`web/src/utils/cleanup-scope.ts`（新增） |
| 执行记录面板按钮改成「清理本任务日志」（没选中任务时禁用） | `web/src/components/logs/LogsPanel.vue` |
| 设置里按钮改成「清理全部任务日志」 | `web/src/components/dialogs/SettingsDialog.vue` |
| 任务卡上挂保留策略标签（「日志保留 30 天」/「日志永久保留」）；没单独设置的不显示 | `web/src/components/task/TaskCard.vue` |
| 单测：任务级清理、任务级保留天数、前端选项与范围映射 | `rust/crates/jitter-core/tests/db.rs`、`web/tests/log-retention.test.ts`、`web/tests/cleanup-scope.test.ts`（新增） |

**约定**：
- 语义统一：**`null` = 跟随全局设置，`0` = 永久保留，`N` = N 天**。前端下拉用 `'inherit'` ↔ `null` 映射。
- `prune_logs` **必须逐任务**处理：全局规则不能把「保留更久」那条任务的旧日志删掉，所以不能先按全局一刀切。
- 保留期同时管**删除**和**查询窗口**：只改删除会出现「设了 30 天但界面只显示 10 天」的割裂。
- 清理范围 id 一律参数化，不拼进 SQL 字符串。
- 弹窗打开时抑制一次 `scope` 的 watch，避免同一次打开拉两遍预检。

### 6.0.5 v2.1.16：跳过 / 错过的记录不可点详情

用户反馈：跳过（skipped）和错过（missed）的记录本来就没发过请求，点「详情 ›」打开抽屉里也没有内容，
应该直接禁掉点击，并用视觉告诉用户「这条没有详情」。

| 改动 | 落点 |
| --- | --- |
| 跳过 / 错过的行不可点：点击不发 `select` 事件，末尾「详情 ›」换成灰色「无详情」，整行头部淡显 | `web/src/components/logs/LogRow.vue`（`noDetail` 计算属性）、`web/src/styles.css`（`.log-item.is-disabled` / `.log-no-detail`） |
| 文案 | `locales/zh-CN.ts` / `en-US.ts`（`logs.noDetail` / `logs.noDetailHint`） |
| 单测：普通记录可点、跳过不可点、错过不可点、合并标记仍能展开 | `web/tests/log-row.test.ts` |

**约定**：
- 只有 `kind = 'skipped'` 和 `kind = 'missed'` 没有详情；`task` / `notify` 照旧可点。
- **合并标记「× N」不受影响**：跳过组也要能展开看每一条，所以它是 `stop` 传播，不走行的点击。

### 6.0.4 v2.1.15：执行记录合并显示

用户反馈：连续重复的执行记录（截图里是一串「不在执行时段被跳过」）刷屏，渲染压力大也不好读，
要求能合并显示，并且**合并后还能点开看**。

| 改动 | 落点 |
| --- | --- |
| 归组规则：相邻且「结构性字段」完全一致才算同型；错误文本只把**第一个**时间戳抹掉（「当前 18:55」→「当前 \<now\>」），后面的时间窗保持原样 | `web/src/utils/log-merge.ts`（`logGroupKey` / `normalizeLogError` / `groupLogs`） |
| 记录行抽成组件，主行与展开后的子行共用 | `web/src/components/logs/LogRow.vue`（新增） |
| 面板头部加「合并重复记录」开关（默认开，偏好存 localStorage），行上显示「× N」，点它展开 / 收起 | `web/src/components/logs/LogsPanel.vue` |
| 合并组展开区用浅底 + 左边线区分 | `web/src/styles.css`（`.log-group` / `.log-group-body` / `.merge-tag`） |
| 单测覆盖归一化、同因合并、不同窗口不合并、中间断开、耗时不影响归组 | `web/tests/log-merge.test.ts` |

**约定**：
- **只合并相邻**记录；中间夹了一条别的类型就断开分组。
- 归组键**不含耗时和记录 id**——它们每次都在变，带上就永远合并不了。
- 合并只影响显示：记录一条不少，展开后每条都能单独看详情。
- 跳过原因里的时间窗（「不在执行时段 23:55–01:05 内」）必须留在归组键里，
  只抹掉「当前 HH:MM」这一个时间戳，否则不同的时段会被误并成一组。

### 6.0.3 v2.1.14：复制任务

用户需求：能复制一条已经建好的任务，再新建一条。

| 改动 | 落点 |
| --- | --- |
| 任务卡「更多」新增「复制任务」菜单项 | `web/src/components/task/TaskCard.vue`（`act('copy')` → `emit('copy')`） |
| 列表把 copy 事件往上抛 | `web/src/components/task/TaskList.vue` |
| 表单新增 `loadDraft(task)`：用 `formModelFromTask` 整份填好，**清掉 editingId**（提交走 create 而不是 update），名字加「 - 副本」 | `web/src/components/task/TaskForm.vue` |
| App 层：拉完整任务 → `loadDraft` → 弹窗标题「复制任务」 | `web/src/App.vue`（`formMode` 多了 `'copy'`） |
| 复制后的默认名字（超 200 字截断原名、按码点切不切坏 emoji） | `web/src/types/form.ts`（`copiedTaskName`） |
| 中英文文案 | `locales/zh-CN.ts` / `en-US.ts`（`task.menuCopy` / `task.copyTitle` / `task.copiedStatus` / `taskForm.copySuffix`） |

**约定**：复制是**纯前端**行为，不加后端接口——复制的本质是「用旧任务填新建表单」。
复制来的内容就是这次的起点，所以 `baseline` 也按复制后的内容算，**不改动不算「有未保存的修改」**。

### 6.0.2 v2.1.13：新增执行条件「已连接网络」

用户需求：执行条件里加一条「已连接网络」（连着 WiFi **或**插了网线都算），
并明确所有执行条件之间是**「与」**——任意一个不满足就不执行。

| 改动 | 落点 |
| --- | --- |
| 主机环境新增网络探测：列出已连接的物理网卡（WiFi / 有线），排除虚拟网卡 | `rust/crates/jitter-core/src/host.rs`（`NetworkKind` / `NetworkConnection` / `network_connections()`） |
| 电源 / 网络 / 本机 IP 三个环境条件统一按「与」判定，网络不满足时跳过并写明原因 | `rust/crates/jitter-core/src/guard.rs`（`HostGuardConfig.require_network` / `evaluate_host_guard`） |
| 数据库新增 `precheck_require_network` 列（只走迁移，不进 `CREATE TABLE`，与 `precheck_day_type` 一致） | `rust/crates/jitter-core/src/db.rs`（`ensure_column` / `TaskRow` / `NewTaskInput` / INSERT `?35` / UPDATE `?35`） |
| API 解析 `precheck_require_network`；`/api/system/environment` 额外返回 `networks` | `rust/crates/jitter-app/src/api.rs` |
| 调度执行与测试台都把当前网卡列表喂给条件判定 | `executor.rs` / `testbench.rs` |
| 任务表单「执行条件」新增复选框「只在已连接网络时执行」，并写明条件之间是「与」 | `web/src/components/task/ConditionFields.vue` |
| 任务卡条件摘要 / 明细新增「网络」一行；环境提示里显示当前网络 | `web/src/utils/condition.ts` / `web/src/utils/environment.ts` |
| 中英文文案补齐（`condition.requireNetwork` / `condition.conjunctionHint` / `env.network*`） | `web/src/locales/zh-CN.ts` / `en-US.ts` |

**约定**：网络条件算一个条件，它内部的「WiFi 或网线」是「或」；它和其它条件之间是「与」（见 4.21）。

### 6.0.1 v2.1.11：细节打磨（v2.1.10 发布后的反馈）

| 改动 | 落点 |
| --- | --- |
| 执行记录一行的状态 tag（HTTP 状态 / 成功 / 已通知）挪到**请求地址后面**，读起来是「做了什么 → 结果如何」 | `components/logs/LogsPanel.vue`（`.log-head` 顺序）、`styles.css`（`.log-request` 改成 `flex: 0 1 auto`，不然地址会把 tag 顶到下一行） |
| JSON / 代码内容改用 `highlight.js`：JSON 缩进 2 空格 + 高亮，脚本按对应语言高亮，长行折行 | `components/common/CodeBlock.vue`（新增，替换 v2.1.10 的 `JsonViewer`） |
| 代码字体换成 JetBrains Mono（只内嵌 latin 子集 40 KB） | `styles.css`（`@font-face` + `--mono`） |
| 日历藏掉 antd 的「月 / 年」视图切换（年视图跟我们的按天渲染对不上，切过去是乱的） | `components/dialogs/CalendarDialog.vue`（`.ant-picker-calendar-mode-switch`） |
| 顶栏「更多」改成鼠标悬停即展开（点击也保留，触屏设备还得靠点击） | `App.vue`（`:trigger="['hover', 'click']"`） |

### 6.0 v2.1.10：界面精简与信息分层（电脑端优先）

本轮只动前端（`web/src/**`），Rust 代码一行没改（只有 `Cargo.toml` 的版本号跟着 bump）。目标是「电脑端体验优先，最多兼容平板端」。

| 改动 | 落点 |
| --- | --- |
| 中文下日历月份/星期不再是英文 | `web/src/i18n.ts` 注册 `dayjs/locale/zh-cn` |
| 任务卡「上次执行」压成一行（结果 tag + 「几小时前」），其余进 title 提示 | `components/task/TaskCard.vue`（新增 `lastRunTitle`） |
| 调休上班日按工作日标注：主标签「工作」+ 副标签「调休 · 节日名」，图例「工作日」计数含调休 | `components/dialogs/CalendarDialog.vue`（`cellLabel` / `cellNote` / `summary`） |
| 详情抽屉里通知详情挪到**最下面**，独立成「通知详情」分区 | `components/logs/LogDetailDrawer.vue`（`notify-section`） |
| JSON / 代码内容改用 `highlight.js` 渲染：JSON 自动缩进 2 空格 + 高亮，脚本按对应语言高亮，全部用 JetBrains Mono 等宽字体 | `components/common/CodeBlock.vue`（新增），用在详情抽屉和测试台 |
| 日历星期表头跟日期列对齐（antd 默认右对齐，看着是歪的） | `components/dialogs/CalendarDialog.vue`（`:deep(.ant-picker-content th)`） |
| 顶栏只留品牌 + 状态位 + 时钟 + 指标 + 「试跑 curl」+「更多」，次要入口和语言切换收进下拉 | `App.vue`（`moreMenu` / `onMoreClick`） |
| 宽屏铺满（去掉 1500px 上限），执行记录把请求 URL 并进首行 | `styles.css`（`.page` / `.topbar-inner` / `.layout` / `.log-request`）、`components/logs/LogsPanel.vue` |

**设计约定**（改之前先读，免得改回去）：
- **调休上班日是工作日**，服务端 `holiday` 数据里的 `dayType: 'makeup'` 落在周末但性质是上班，
  所以 UI 的「工作日」计数必须包含它；不要为了「计数加起来等于天数」而把它从工作日里减掉。
- 任务卡的「上次执行」只保留一行；准确时刻、触发来源、HTTP 状态码、耗时统一进 `title` 提示，
  **信息不删，只是不常驻显示**。
- 通知详情固定排在抽屉**最末尾**，且与任务执行记录视觉分区，不要再插回中间。
- 顶栏用 `a-dropdown` 的 `:menu` prop（**不是 `#overlay` 插槽**，见 4.15），菜单项走 `onClick` 分发。

### 6.1 v2.1.9 及更早：后端健壮性
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
- vue-i18n 11 接入，684 条文案中英各一份，`MessageSchema = typeof zhCN` 保证 key 一致。
- 顶栏语言切换走「更多」下拉菜单（`a-dropdown` 的 `:menu` prop），立即生效 + localStorage 持久化 + 同步 `<html lang>`，antdv-next locale 同步。
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

1. **用户自己的实例的更新**：安装版带产品自带的检查升级机制，会自动升级（当前已是 2.1.17）。
   v2.1.18 发布后由用户自己点更新即可；**不要擅自重启 `D:\下载\Compressed\jitter.exe`**。
2. **未实跑验证的**：`docker build`（本机没有 docker 命令），Dockerfile 改动后没跑过。
3. **本地 vite dev server 起不来**（`bun run dev` 后台无响应），本机调试只能走
   `bun run build` + `cargo build --release` + `scripts\dev-instance.ps1` 起的隔离实例，
   别在 dev server 上浪费时间。

## 七之二、本轮最终状态（已实测）

**测试（2026-11-26 实测，v2.1.18）**

| 项目 | 结果 |
| --- | --- |
| `cargo test -p jitter-core --jobs 1` | **全绿**（新增 `autostart_entries_are_isolated_per_instance` / `production_instance_paths_match_the_legacy_layout` / `mutex_names_are_isolated_per_instance`） |
| `cargo test --workspace --jobs 1` | core + app 全绿 |
| `bun run typecheck` | 退出码 0 |
| `bun run test` | **14 文件 / 110 用例全绿**（新增 `tests/instance-badge.test.ts`） |
| `cargo build --release -p jitter-app --jobs 1` | 成功（含新前端产物） |
| 浏览器实测（dev 实例 3111） | 见下方 v2.1.18 实测结论 |

**发布体积（2026-11-26 实测，Release v2.1.18）**

| 项 | 大小 |
| --- | --- |
| `jitter-windows-x64.zip` | **3,343,878 B（3.19 MB）** |
| `jitter-linux-x64.zip` | 3,212,063 B |
| `jitter-macos-x64.zip` | 3,062,332 B |
| `jitter-macos-arm64.zip` | 2,997,386 B |
| `jitter-linux-arm64.zip` | 3,184,898 B |
| `web/dist/assets/index-*.js` | ≈1,753 kB（gzip ≈491 KB） |
| `web/dist/assets/jetbrains-mono-latin-wght-normal.woff2` | 40.4 KB |

> release profile 已是 `opt-level="z" + lto + codegen-units=1 + strip=true`，没有进一步空间。
> 发布包解出来的 `jitter.exe` 是 7,744,512 B。

**发布产物实测（v2.1.18）**

- 从 Release 下载 `jitter-windows-x64.zip` + `.sha256`，**sha256 完全一致**
  （`e3e3f85ea5496e0a32b04a56622eff52bf43f09d7946beabc3aa51ba81fc0b17`）。
- 解压出的 `jitter.exe` 对生产库跑 `probe`：exit=0，输出完整（1698 B），
  生产库 `app.db` / `app.db-wal` / `app.db-shm` 指纹不变，生产实例 3000 端口照常响应。

**实例隔离实测结论（v2.1.18）**

- 以 `JITTER_INSTANCE=dev` 起实例：`config_dir` = `%APPDATA%\Jitter\Jitter-dev`、
  `autostart_path` = `Startup\Jitter-dev.cmd`、runtime 文件独立（端口 3111 / PID 独立）。
- **正式实例的 runtime 文件一字未动**：仍是 `{"port":3000,"pid":40004}`，3000 端口照常响应。
- **最关键的一条**：在 dev 实例的设置里点「开机自启」，
  正式实例的 `Startup\Jitter.cmd`（298 B，mtime 8:43:56）**一个字节都没变**；
  新增的是 `Jitter-dev.cmd`（334 B，指向开发版 exe）。关掉 dev 自启后只剩正式的那份。
- dev 实例退出后，正式实例的 runtime 文件仍在、3000 仍正常。
- `scripts\dev-instance.ps1` 实际跑通（脚本里曾把 health 接口的 `url` 字段取错，已修）。

**只读探针实测结论（v2.1.18）**

- 对正式库跑 `probe --db "D:\下载\Compressed\data\app.db" --logs "…\data\logs" --limit 5`，
  正常输出 4 个任务、364 条记录（其中 258 条出错）、全局设置、任务明细、最近记录、运行日志尾部。
- **探针前后 `app.db`(684032 B) / `app.db-wal`(4169472 B) / `app.db-shm`(32768 B)
  的大小与 mtime 全部不变**，正式实例全程照常在跑。
- 探针不占端口、不抢互斥体、不初始化自己的数据库。

**界面实测结论（v2.1.18，dev 实例 3111）**
- 顶栏版本号旁出现橙色「实例 dev」标记；正式实例不显示（默认实例不标）。
- 设置页「运行信息」区有「实例」行，显示
  `dev （非生产实例，配置 / 数据 / 开机自启都与生产实例互相独立）`。
- 设置页同时显示 dev 实例自己的安装目录 / 数据文件 / 开机自启文件路径，都是 dev 专属的。
- 页面 0 console error / 0 warn。

> ✅ **副本实例的副作用已根治**：v2.1.17 之前所有实例共用 `%APPDATA%\Jitter\jitter.runtime.json`，
> 副本实例启动会覆盖它、退出时会删掉它，测完还得手工改回 `{"port":3000,"pid":<用户实例PID>}`。
> v2.1.18 起配置目录按实例隔离，这个坑不复存在。

**界面实测结论（v2.1.17，副本实例 3111）**
- 任务表单第 5 段「日志保留」正常渲染，下拉共 8 项：跟随全局设置 / 保留 1、7、30、90、180、365 天 / 永久保留。
- 保存后落库正确：`/api/tasks` 返回 `log_retention_days`：设 30 天的任务 = 30，没设的 = null。
- 任务卡上出现「日志保留 30 天」标签；没单独设置的任务**不显示**标签（避免每张卡都挂噪音）。
- 从执行记录面板进清理弹窗：默认范围 = **只清理任务「上🚗」**，预检 15 条 / 21.5 KB。
- 从设置进清理弹窗：默认范围 = **清理全部任务**，预检 40 条 / 281 KB。
- 弹窗内切换范围会重新统计：15 条 ↔ 40 条，档位文案也跟着变（「只保留这个任务最近 10 天」↔「保留最近 10 天」）。
- 实跑一次任务级清理（保留最近 10 天）：删掉 2 条、剩 13 条；**另外两个任务的日志条数完全没变**。
- 保留天数确实驱动**查询窗口**（不只是删除）：设 1 天的任务可见条数 0；设「永久保留」(0) 的任务窗口返回 0、条数回到 10；没设的返回全局 30。
- 页面 0 console error / 0 warn。

> ⚠️ **副本实例的副作用**：所有实例共用 `%APPDATA%\Jitter\jitter.runtime.json`（记录端口与 PID）。
> 副本实例启动会覆盖它、退出时会删掉它。测完副本实例后要把这个文件改回用户实例的
> `{"port":3000,"pid":<用户实例PID>}`，否则用户下次双击 exe 会跳到错误端口。

**界面实测结论（v2.1.10 / v2.1.11）**- 顶栏单行：品牌 + 版本、状态位、时钟、指标、「试跑 curl」、「更多」；次要入口与语言切换都在「更多」下拉里，当前语言前带 ✓。
- 1920 宽屏下左右两栏铺满可用宽度，右侧执行记录不再只剩半屏。
- 任务卡「上次执行」单行（结果 tag + 「几小时前」），完整信息在悬停提示里。
- 日历中文下月份/星期正常（`Jan/Sun` → `1月/一`）；调休上班日显示「工作」+「调休 · 节日名」，图例「工作日」计数已含调休（2026-02：工作日 16 / 休息日 3 / 法定节假日 9 / 调休上班 2）。
- 日历星期表头与日期列**偏移 0px**（antd 默认右对齐，已改成左对齐并对齐内边距）。
- 日历只保留「月」视图，antd 的「月 / 年」切换已藏掉（年视图跟按天渲染对不上）。
- 详情抽屉里「通知详情」在最末尾独立分区，请求/响应各块顺序不变。
- JSON（请求头/请求体/响应头/响应体/通知响应体）走 `highlight.js`：JSON 缩进 2 空格 + 高亮，脚本按语言高亮，JetBrains Mono 等宽字体，长行折行。
- 执行记录一行：任务 → 时间 → 耗时 → 触发方式 → 请求地址 → 状态标签（HTTP 状态 / 成功 / 已通知）→ 「详情 ›」。
- 执行条件区新增「只在已连接网络时执行」复选框，下方实时显示当前网络（本机实测为「以太网」）；
  底部固定一行「多个执行条件是「与」的关系：必须全部满足才执行，任意一个不满足就跳过本次。」。


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

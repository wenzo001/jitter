# Jitter

先测通，再定时：一个本地 curl 测试台 + 调度器。

## 两种实现：Rust（发布物）与 TypeScript（参考实现）

本项目有两条代码线，共用同一套前端（`src/frontend/`）与同一套 API 契约：

- **Rust 版（`rust/`）是发布物**：axum + tokio + rusqlite，单文件原生二进制（debug 13MB / release 约 8–10MB），Windows 版带托盘图标，支持开机自启、网页端数据库备份 / 导入 / 恢复、以及从 GitHub Releases 自动升级。**从 [Releases](https://github.com/wenzo001/jitter/releases) 下载 `jitter-windows-x64.zip`（或对应平台资产）解压运行即可。**
- **TypeScript 版（`src/`）是参考实现**：Bun + Elysia，功能完整并保持 360 项测试作为行为基准，Rust 版按它逐模块对齐（当前 198+ 项测试）。日常开发两边的测试都要跑：`bun test` 与 `cargo test -p jitter-core`。

```bash
# Rust 版（发布物）
cd rust
cargo run -p jitter-app
cargo test -p jitter-core

# TypeScript 版（参考实现）
bun install
bun run start
bun test
```

Jitter 的主线是「测试 curl」和「定时调用 curl」：

- **测试台**：顶栏、curl 输入框旁、每张任务卡上都能打开。把一次正式执行按顺序跑一遍——解析 curl → 本地条件 → 前置判断 → 主请求 → 成功条件 → 通知。每一步都能看到请求、响应、耗时和判定结果；默认不写执行记录、不真发通知。测试过的配置可以一键存成任务，每个任务保留最近 10 次测试记录可回看。
- **开机自动执行（单任务）**：任务表单里可勾选「电脑启动后自动执行一次」，默认关闭，只对当前任务生效。Jitter 启动 15 秒后，对开启该选项的任务各执行一次，仍会检查任务的执行条件（电源 / IP / 星期 / 时段 / 条件检查 curl），不满足则写入跳过记录。只在进程启动时触发，恢复备份或导入后重启调度不会触发；与「错过窗口不补跑」的定时语义相互独立。
- **调度**：两种方式任选——「定时执行」（每天一次，可选时间范围 / 精确时间 / 精确时间±抖动）和「循环执行」（每隔 N 秒 / 分 / 时 / 天）。不提供 Cron 表达式。
- **执行前判断**：到达执行时间先判断是否要跑——「星期 / 时段 / 接通电源 / 本机 IP」这类本地条件不发请求直接判断；配了「前置 curl」时再发请求按状态码/表达式判断。任一不满足则跳过本次，并在记录里写明原因。条件只约束定时自动执行，「立即执行」不受限制。
- **命中条件**：状态码 / 响应体 / 表达式，决定每次执行是否记为「命中」，与是否发通知无关。
- **历史**：所有请求与响应长期写入 SQLite，页面按任务查看聊天式记录，可停止、暂停、编辑、删除。
- **运行统计**：顶栏常驻一行概览（今日执行次数、近 7 天成功率与平均耗时），点「统计」看到每个任务最近 20 次的成功率、平均耗时和最近一次结果。
- **任务列表可拖动排序**：每张卡片左侧有拖拽柄，拖动即可调整顺序（也可用手指拖）；聚焦拖拽柄后按 ↑ / ↓ 也能移动。顺序会存进数据库，重启后保持。

旧版本创建的任务（只有窗口）会自动按「每天窗口」继续运行，数据库采用增量迁移，不需要手工改表。

## 技术栈

| 层 | 选择 |
|---|---|
| 运行时 | Bun 1.4.4（已验证 HTML import、`Bun.serve` routes） |
| 后端 | Elysia 1.4.31（与 `Bun.serve` 同进程；未回退 Hono） |
| 数据库 | `bun:sqlite`，`PRAGMA journal_mode = WAL` |
| 调度 | 任务级 `setTimeout`（唯一权威计划）+ 每分钟一次的兜底巡检（补回丢失的 timer）；计划由 `src/schedule.ts` 计算 |
| HTTP 执行 | `fetch` + `AbortController` |
| 前端 | 原生 HTML/CSS/JS，无构建链；Bun HTML import 自动打包 `app.js` |

## 启动

要求 Bun 1.4+。

```bash
bun install
bun run src/index.ts
```

控制台会打印实际访问地址、监听地址、数据库、使用的配置文件和恢复的任务数。默认读取项目根目录的 `jitter.config.json`；端口被占用时会自动尝试下一个端口（见下文“配置”）。

环境变量（优先级高于配置文件）：

- `JITTER_CONFIG`：配置文件路径，默认项目根目录的 `jitter.config.json`
- `PORT`：监听端口，覆盖配置文件的 `port`
- `HOST`：监听地址，覆盖配置文件的 `host`
- `JITTER_DB_PATH`：SQLite 路径，覆盖配置文件的 `dbPath`

其他命令：

```bash
bun test            # 343 项：核心逻辑 / curl / 配置 / 调度 / 定时（范围/精确/抖动）与循环 / 本地条件 / 前置判断 / 测试台 / 测试留档 / 编辑 / 删除 / API / 数据库 / 执行器 / 条件表达式
bun run typecheck   # tsc --noEmit
```

## 配置

默认配置文件 `jitter.config.json`（可选；不存在时使用内置默认值），也可以通过 `JITTER_CONFIG` 指定其他路径。仓库内的文件是可编辑示例：表中的值是**内置默认值**，文件中的值会覆盖它们。

优先级：**内置默认值 < 配置文件 < 环境变量**（`PORT`、`HOST`、`JITTER_DB_PATH`）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `port` | `3000` | 监听端口；`0` 表示由系统分配 |
| `host` | `127.0.0.1` | 监听地址 |
| `autoIncrementPort` | `true` | 端口被占用时是否自动 +1 重试 |
| `portMaxAttempts` | `100` | 最多尝试的端口数（包含初始端口） |
| `dbPath` | `data/app.db` | SQLite 路径；配置文件中的相对路径相对于配置文件所在目录 |
| `logBodyLimitBytes` | `102400` | 响应体保存/比较上限（100 KiB） |
| `logsPageSize` | `50` | 日志默认分页大小 |
| `logsMaxPageSize` | `200` | 日志单页上限 |
| `requestTimeoutMs` | `30000` | 默认请求超时（毫秒）；`0` = 不限时（界面会提示风险）；curl 的 `--max-time` 可按任务覆盖 |
| `logRetentionDays` | `30` | 日志保留天数；超过这个天数的日志**不查询、不渲染**，并在后台巡检中分批删除（`0` = 永不自动删）。页面上可在「清理日志」里改成 30 / 90 / 180 / 365 天或不限制，改动立即生效并记住 |
| `logMaxRowsPerTask` | `0` | 每个任务最多保留多少条日志（`0` = 不限） |
| `shutdownGraceMs` | `150` | SIGINT/SIGTERM 后等待在途中断日志落库的时间 |
| `defaultWindowMinutes` | `5` | 新建任务表单的默认窗口时长 |
| `pollIntervalMs` | `4000` | 前端刷新任务/日志的轮询间隔 |

- 未知配置项、错误类型或越界值会在启动时直接报错，不会静默回退；`$schema` 可作为编辑器元数据忽略。
- `JITTER_CONFIG` 的相对路径相对于进程工作目录；`JITTER_DB_PATH` 的相对路径也相对于工作目录；配置文件中的 `dbPath` 相对路径相对于配置文件目录。
- 端口占用自动重试：只对 `EADDRINUSE` 生效，按 `port + 1` 继续尝试，最多 `portMaxAttempts` 个端口；每次重试和最终切换都会打印。其他启动错误不重试；全部端口占用时以清晰错误退出。`autoIncrementPort: false` 时首次占用即失败。
- 前端通过 `GET /api/config` 获取 `logsPageSize`、`defaultWindowMinutes`、`pollIntervalMs`、`logBodyLimitBytes`，用于默认窗口、日志分页、轮询和响应体上限提示。
- `requestTimeoutMs > 0` 时，超时会写入 `aborted=1` 和 `error="请求超时（N ms）"`，随后按正常流程规划下一次执行；`0` 表示保持长时间请求，直到完成或手动停止（页面会给出醒目提示）。单个任务可用 curl 的 `--max-time` 覆盖。
- **日志自动保留**：`logRetentionDays`（默认 30 天）与 `logMaxRowsPerTask`（默认不限）在每次后台巡检时执行一次（最多 5 分钟一次），服务启动时也会跑一遍。每轮最多删 5000 行（单线程下不能让一条大事务卡住全站），积压分批消化。页面上的「清理日志 → 保留窗口」可以改成 30 / 90 / 180 / 365 天或不限制，存进数据库即刻生效（配置文件里的值是默认值）。
- **旧日志不查也不渲**：日志列表只返回保留窗口内的记录，窗口之外的行连查询都不会发生（`executed_at >= cutoff` 走索引），所以日志堆到几十万行也不会拖慢列表。

## 调度语义

### 两种执行方式

| `schedule_kind` | 关键字段 | 行为 |
|---|---|---|
| `daily`（默认） | `window_start` / `window_end`、`daily_jitter_minutes` | **定时执行**：每天一次，三种形态见下表；旧版本创建的任务全部属于「时间范围」 |
| `interval` | `interval_seconds`、`interval_jitter_seconds`、`interval_start_at` | **循环执行**：每隔 N 秒执行一次，可指定首次执行时间并另加 0–N 秒抖动 |

「定时执行」的三种形态（表单里用「时间范围 / 精确时间 / 精确 + 抖动」切换）：

| 形态 | 存储方式 | 实际执行 |
|---|---|---|
| 时间范围 | `window_start=A`、`window_end=B`（A≠B） | 每天在 `[A, B)` 内随机一个时刻；`B < A` 表示跨午夜 |
| 精确时间 | `window_start = window_end = T`，抖动 0 | 每天 **T 整**执行一次，不随机 |
| 精确 + 抖动 | 同上，另存 `daily_jitter_minutes = N` | 每天在 `[T-N, T+N]` 内随机一个时刻；例：18:00 + 5 → 17:55–18:05 |

- 精确时间只有 HH:mm 精度，实际触发有秒级延迟（正常 0–3 秒）；定时器晚到不超过 60 秒仍算按时执行，超过则记一条 `missed` 并等次日，不补跑。
- 抖动上限 60 分钟，只会配「精确时间」使用（配时间范围时返回 400）；靠近 00:00 时随机范围会被截断到当天，不会跨到前一天或后一天。
- 三种形态都遵守“每天一次”和暂停规则：暂停那一天整天跳过，恢复日按各自形态重新排一次。
- 不支持 Cron 表达式：五段式语法对普通用户不友好，实际需求（每天一次 / 每隔一段时间）用上面两种就能表达。
- 间隔上限 30 天，抖动不能大于间隔；秒级精度来自 `interval_seconds = 1`，实际触发仍受事件循环与机器休眠影响，不适合要求毫秒精度的场景。
- **首次执行时间可选**（`interval_start_at`）：留空 = 从创建/恢复的那一刻开始算；填写后整个周期对齐到该时刻——例如「从 09:00 开始、每 2 小时」→ 11:00、13:00、15:00（若创建时已过 09:00，第一次落在下一个整点）。这个锚点会在重启、编辑、暂停之后继续生效，不会退回「从现在起算」。
- 循环执行的下一次锚定在计划时刻：耗时 2 秒的请求不会让「每 60 秒」逐渐漂移；只有请求跨过了下一个计划时刻，才从当前时刻重新起算。
- 循环执行不补跑：进程在 10:00–10:05 停机，10:06 启动后只等 10:06 之后的下一次触发。
- 迟到判定：循环执行的定时器比计划晚到超过「间隔的一半，限制在 5–60 秒」时，记一条 `missed` 并重排，不补执行；定时执行仍按窗口是否关闭判断。
- 暂停对所有方式一致：按完整自然日跳过，落在暂停日内的循环执行同样被跳过；暂停结束后仍落在原来的网格上。
- 每分钟一次的兜底巡检会检查每个 active 任务的计划是否仍有 timer 支撑，丢了就补上（代替旧版本按窗口注册的每日触发器）。
- 表单里会实时列出**接下来 7 次执行时间**：时间范围显示「日期 + 窗口」，精确时间显示具体时刻，精确 + 抖动显示浮动后的时段，循环执行显示具体时刻——存之前就能看清后续规律。
- 任务卡片上会直接显示「下次执行时间」和「从何时起算」，不需要自己换算。
- 任务列表可以拖动排序：卡片左侧的「⠿」是拖拽柄，按住拖动即可换位置，落点会有一条蓝色插入线；拖动时原位留一个虚线占位框，列表不会跳动；按 Esc 取消。也可以聚焦拖拽柄后用 ↑ / ↓ 逐格移动（无鼠标/触屏时的等价操作）。顺序通过 `POST /api/tasks/reorder` 存进 `tasks.sort_order`，刷新和重启后都保持；新任务默认排在最前面。

### 窗口归属

窗口使用本地时区的 `HH:mm`，**按开始日归属**。例如窗口 `23:50–00:10` 属于开始日 D，随机时刻可能落在 D 的 23:50–23:59，也可能落在 D+1 的 00:00–00:10；每次窗口只执行一次。

- `window_end > window_start`：当天窗口。
- `window_end < window_start`：跨午夜窗口，时长按跨天计算。
- 起止相同会被拒绝。

### 规划与恢复

每个 active 任务在稳定状态下都有 `next_run_at`，并最多有一个已武装的 timer（执行中的瞬间会暂时保留已执行的目标，结束后再规划）：

1. 新建 / 恢复：若当前在窗口内，在 `[now, 窗口结束)` 随机；否则在下一个窗口内随机。
2. 每分钟的兜底巡检负责补漏：计划缺失或 timer 丢失时重新规划 / 重新武装。
3. 执行结束后规划下一个窗口（跨午夜任务自动落到下一个开始日）。
4. 启动恢复：
   - `next_run_at` 在未来：原样恢复 timer。
   - 已过但仍在当前窗口内：在剩余窗口重新随机。
   - 窗口已关闭：写入一条 `kind='missed'` 日志（**不补跑**），再规划下一个窗口。
   - 当前早于今天窗口：规划今天。
5. timer 触发时会重新读取 DB，确认任务仍为 `active`、`next_run_at` 仍是本次目标；每次重规划、停止、恢复以及**非在途时**的暂停/取消暂停都会递增内存中的 generation，旧 timer 与旧执行回调自动失效（在途时暂停只更新状态，见「暂停」）。如果触发时窗口已经结束（例如机器休眠后 timer 迟到），按错过处理并记录 `missed`，不会越过窗口补执行。

### 停止

停止任务会同时：

1. 清除该任务的 `setTimeout`；
2. `abort()` 正在进行的请求；
3. 写入 `status='stopped', next_run_at=NULL`；
4. 保留全部历史日志。

正在进行的请求被中断后，会在日志中记录 `aborted=1`、`error="请求已中断"`。停止后的任务不再被调度；恢复会重新规划并重新武装 timer。

### 删除

任务卡片上的「删除」通过 `DELETE /api/tasks/:id` **永久删除任务及其名下全部日志**（任务执行记录、通知记录、错过记录），不可恢复；任务不存在返回 `404`。删除与「停止」的区别：停止可恢复且保留历史，删除两者都不留。

删除会依次完成：停止 timer 并清除 `setTimeout`、`abort()` 在途请求、递增 `generation` 使旧回调失效并移除调度状态；**等待在途请求收尾写入其中断日志后**，再在单个数据库事务内先删该任务的全部日志、再删任务行（外键 `logs.task_id → tasks.id` 要求这个顺序）。因此删除完成后该任务不会残留任何日志，也不会出现外键错误或孤儿日志。中断日志在任务行删除前落库，随后一并被清除。

前端为防误删，要求手动输入完整任务名后才会启用「确认删除」按钮；若被删任务正处于编辑中或为当前选中项，会一并退出编辑并清空日志视图。全局日志清理（见下文）仍可用于按时间批量管理其他任务的日志。

### 立即执行

任务卡片上的「立即执行」通过 `POST /api/tasks/:id/run` 让该任务**马上完整执行一次**：复用定时执行同一条链路（发请求、写执行日志、判定条件、命中则发通知），因此执行记录里能看到这次结果，行为与窗口触发的执行一致。

- **不影响定时计划**：`next_run_at` 与 timer 原样保留，本次只是额外插入的一次执行，下一次仍在原窗口运行。
- **防重复**：同一任务正在执行（定时触发或另一次立即执行）时再次点击会被拒绝，返回 `409`，避免对有副作用的端点（如打卡 POST）重复发送。
- 任务不存在返回 `404`；删除任务若发生在立即执行途中，会先中止该执行、等其中断日志落库后再删任务与日志，不留孤儿记录。
- 返回 `{ ok, status, matched, error, aborted, durationMs, notifySent }`。前端显示执行中状态与结果摘要，完成后刷新该任务的日志。

与「测试台」的区别：测试台是对**当前填写的配置**把整条链路跑一遍、不写执行记录（通知默认只演练，可一键存成任务）；立即执行是针对**已建立的任务**跑一次真实流程、会写日志、会走执行前判断并可能发通知。

### 编辑已有任务

任务卡片上的「编辑」会把当前配置填回表单，改完点「保存修改」即通过 `PUT /api/tasks/:id` 覆盖配置，随后按新配置继续定时；「取消编辑」恢复新建表单。字段与创建时相同，沿用同一套校验（窗口、curl、通知 curl、条件表达式）；非法输入返回 `400` 且不改动原任务，任务不存在返回 `404`。

- 运行中的任务：**窗口没变**时保留已经排好且尚未到点的下一次执行（含其随机时刻），不把计划排回已消费的窗口造成同日二次执行；**窗口改了**时旧计划不再适用（否则会被判为“错过执行”而不发请求），会按新窗口重新规划一个执行时刻。两种情况都会重新武装 timer，并在那次执行完成后按新配置规划后续窗口。
- 请求在途时保存：只更新配置并重新武装 timer，不递增 `generation`、不动 timer，由在途请求的收尾读取新配置规划下一次（与暂停/恢复的在途规则一致）；若同时改了窗口，收尾会在新窗口内安排一次执行，而不是把它当成已消费跳过。
- 已停止的任务：只更新配置，保持停止；之后「恢复」会按新配置重新排期。
- 暂停中的任务：保存后保留原暂停区间与已排好的计划。
- 任务下次执行使用保存后的**新 URL / 方法 / 请求头 / 通知与条件**；历史日志不变。

### 暂停（按完整自然日，与当前是几点无关）

任务卡片上的「暂停」按**完整自然日**跳过调度，天数 1–15 天，起算日选 **明天（默认）** 或 **今天**。数据库里存的是半开区间 `paused_from` / `paused_until`（本地时区的日 00:00）：

| 选择 | 区间 | 被暂停的自然日 | 恢复 |
|---|---|---|---|
| 今天开始 N 天 | `[今天 00:00, 今天+N 天 00:00)` | 今天 … 第 N-1 天（共 N 天） | 第 N 天 00:00 |
| 明天开始 N 天 | `[明天 00:00, 明天+N 天 00:00)` | 明天 … 第 N 天（共 N 天） | 第 N+1 天 00:00 |

- **今天开始**：今天算一个完整暂停日，与现在是中午还是 23:00 无关；今天剩余的所有窗口（包括尚未到达的下午/晚上窗口）都不再触发。周一中午选「今天开始 2 天」→ 暂停周一、周二，周三 00:00 恢复。
- **明天开始**：今天完全不受影响，今天已排好的计划不会被取消，下午/晚上的窗口照常执行；从明天 00:00 起才跳过 N 个自然日。周一中午选「明天开始 2 天」→ 今天照常，暂停周二、周三，周四 00:00 恢复。
- 判定依据是**窗口实例的归属日**（见「窗口归属」），既不是「设置暂停的那一刻」，也不是「请求实际发出的时刻」。跨午夜窗口 `23:50–00:10` 属于开始日 D：即使随机点落在 D+1 的 00:05，仍按 D 判断，所以「从明天开始」不会误伤今天窗口的尾巴，「从今天开始」也不会让它漏跑。
- 恢复后的第一次执行落在**恢复日自己的窗口实例**内随机一次，而不是恢复日 00:00 所在的那个窗口实例（否则跨午夜窗口会落回暂停日的尾巴）。
- 暂停是 `active` 任务的属性，`status` 仍为 `active`；每分钟的兜底巡检继续覆盖暂停期间与恢复日。设置暂停时，起算日之前已经排好的计划保持不变；启动恢复同样保留它。
- 取消暂停（`resume`）清除区间并立即重新规划；停止任务也会清除暂停标记；暂停过期后由巡检 / timer / 启动恢复自动清理。
- 暂停不中断已经发出的请求，该请求正常完成并写日志，之后再按暂停规则规划下一次。**在途期间**设置或取消暂停只更新暂停区间，不递增 `generation`、也不武装新 timer，由在途请求的收尾按最新区间规划，避免把计划排回已消费的窗口造成二次执行或搁浅。
- 旧版本只存 `paused_until`，无法还原起算日（也正是「从明天开始却跳过今天下午」这个 bug 的根源）。`updated_at` 会被每次 timer 重规划改写，不能用来推断设置时刻。升级时改用确定性规则：已过期的直接清除；仍有效的保留原恢复时刻，把 `paused_from` 设为**升级当天 00:00**，并清掉旧代码错误推到恢复日的 `next_run_at`，由调度器按新区间重新排期。仍有效的暂停必然覆盖升级当天，因此未来的暂停日与原意完全一致；唯一偏差是「设置当天就升级且选了从明天开始」会多暂停当天，启动日志会提示重新设置一次暂停。

## 成功通知

**成功条件是任务的属性，与是否发通知无关**：即使关闭通知，条件仍会保存，并决定每次执行在记录里标记为「命中」还是「未命中」。通知只是额外的副作用。

新建任务时可额外配置“成功通知”：

- **通知 curl**：命中成功条件后执行的第二条请求（同样使用解析器校验、无 shell）。
- **成功条件**（可组合，全部满足才算命中）：
  - 期望状态码（100–599，可选）
  - 期望响应体（与响应正文**完全相等**，可选；留空表示不启用，暂不支持只匹配空响应体）
  - 条件表达式（对 JSON 响应体按路径取值判断，可选，详见下文）
  - 三项都不填时，任意 `2xx` 视为成功。
- 命中后执行通知 curl，并写入一条 `kind='notify'` 日志，`parent_log_id` 指向主请求日志。
- 未命中则不发送通知。
- 通知请求失败只影响自己的日志，不影响主任务。
- 响应用于比较和存储的正文上限由 `logBodyLimitBytes` 决定（默认 100 KiB）；超过上限会追加 `[truncated]`，且此时“期望响应体”与条件表达式都视为不匹配。
- 条件表达式在建任务时做语法校验，语法错误返回 `400` 且不会创建任务；执行期即使表达式或响应体异常也不会抛错，只会判为“未命中”，不影响主任务日志。

### 条件表达式

条件表达式把响应正文按 JSON 解析后，在一个受限的“类 JS”语法里求值，结果为真值即命中。它**不调用 `eval` / `new Function`**，只解释执行下面的语法，属性访问一律安全，不能调用方法或执行任意代码。

- **取值路径**：根对象就是响应 JSON。顶层字段直接写 `ok`，嵌套写 `data.result.remindtype`；支持 `data.result['description']`、`data.status.records[0].checktype`、`data?.result?.remindtype`（可选链写法与 `.` 一样安全）。字符串也可按下标取字符，`$body[0]='{'`。
- **比较**：`=` 与 `==` 都是**宽松相等**（`"0"` 与 `0` 相等、`null` 与 `undefined` 相等）；`===` / `!==` 为严格相等；另有 `!=`、`<`、`<=`、`>`、`>=`。
- **逻辑与三元**：`&&`、`||`、`!`、`条件 ? 值A : 值B`，可用括号分组；数字运算 `+ - * / %` 也可用，`+` 在任一侧是字符串时按 JS 规则拼接（`'5'+3` 得 `'53'`）。
- **元变量**：`$status` 为 HTTP 状态码，`$body` 为原始响应体字符串，`$json` 为解析后的 JSON 根对象。注意响应 JSON 里的 `status` 字段要写 `status`（或 `data.status`），HTTP 状态码才写 `$status`，别混。
- **字面量**：数字、单/双引号字符串、`true`、`false`、`null`、`undefined`。
- **安全取值**：路径中途为 `null`/`undefined` 时得到“缺失”，任何比较（包括 `!=`）都不成立，且会沿 `!` 与 `==`/`!=` 一致传播——例如 `data.result.missing!=0`、`!(data.missing=0)` 都为 `false`，不会抛错；`__proto__` / `prototype` / `constructor` 等原型键被屏蔽。响应不是 JSON 时路径都取不到，但 `$status`、`$body` 仍可用。
- 表达式最长 1000 字符，超出视为语法错误。

**完整示例：打卡接口的两种响应。** 成功时：

```json
{
  "ok": true,
  "data": {
    "result": {
      "checktime": 1794828938930,
      "description": "19:35在高新人才大厦签退成功",
      "remindtype": 0,
      "checkwarn": null
    },
    "status": { "checkIn": 1, "checkOut": 1 }
  },
  "error": null
}
```

失败时（业务错误，`code` 在根级 `error` 下，**不是** `data.error`）：

```json
{
  "ok": false,
  "data": { "needsMemo": false },
  "error": { "kind": "business", "code": 900, "explanation": "不在规定时间，不允许打卡" }
}
```

针对上面两份响应，可用的表达式：

```
data.result.remindtype=0              # 成功响应命中；失败响应没有 data.result，不命中
ok=true && $status=200                # 成功响应命中（注意 ok 在根级）
error=null                            # 成功响应命中
error.code=900                        # 失败响应命中；成功响应 error 为 null，不命中
ok=false && error.kind='business'     # 失败响应命中
data.result.description!='19:35在高新人才大厦签退成功'   # 负向示例：排除这条签退消息，对成功响应反而不命中
```

**语义提醒**：只填条件表达式、不填状态码和响应体时，系统**不再隐含要求 2xx**——例如写 `$status=500` 在 500 响应上也会命中并发通知。若要限定成功区间，请写进表达式：`$status>=200 && $status<300 && data.result.remindtype=0`。期望状态码一栏填了 `200` 时则与之 AND，无需在表达式里重复。

错过窗口只写 `kind='missed'` 日志并在启动时打印提示，不补跑，也不会触发成功通知（通知只用于成功命中）。

## 执行前判断（不满足则跳过）

任务的另一层判断，发生在**主请求之前**：每次定时到达时，先判断要不要跑（页面「立即执行」是人工触发，不受这些条件限制）。判断分两层，全部通过才继续：

**1. 本地条件（不发请求）**

- **允许执行的星期**：勾选周一…周日，不勾表示每天。
- **执行时段**：`HH:mm`–`HH:mm`，可留空；结束早于开始视为跨午夜（如 `22:00–02:00`），并按**开始那天**归属星期，与窗口归属规则一致。
- **接通电源（AC）**：勾选后，只有笔记本接电源时才执行；用电池时跳过。读不到电源状态时按不满足处理。
- **本机 IP 匹配**：例如 `10.1.*`、`192.168.*,10.*`；`*` 匹配任意数字或点，多组用逗号分隔，任意一组命中即可。读不到本机 IP 时按不满足处理。
- 本地条件不满足时直接跳过，网络层面什么都没发生；`skipped` 记录里 `request_url` 为空。
- 例：`今天是周五，不在允许执行的星期（周一）内；已跳过主请求 GET https://…`

**2. 前置 curl（发请求）**

- 可选。配了才会发；判定方式为**前置期望状态码**（100–599）与**前置条件表达式**（对前置响应 JSON 按路径取值，语法与「条件表达式」一致），两项都不填时返回任意 `2xx` 即视为通过。
- 前置请求失败（DNS/TLS/连接拒绝/超时）同样视为不通过并跳过，原因写 `前置判断请求失败：…`。这样「判断不了」不会被误当成「可以执行」。

**共同规则**

- 任何一层不通过都会跳过本次：不发主请求、不发通知，写入一条 `kind='skipped'` 记录，`error` 写明原因；如果这次发出了前置请求，记录里保存的就是那次请求与响应。
- 前置 curl 与主请求共用传输层与超时配置；它同样会真实发出（GET 判断接口请尽量无副作用）。
- 本地条件与前置 curl 至少要配一项，否则保存时返回 400；只配状态码/表达式而不配 curl 也会被拒绝（没有响应可判断）。
- 执行前判断是任务属性，编辑任务时一并更新；`precheck_enabled=0` 的任务行为与旧版本完全一致。
- 测试台会把本地条件、前置 curl 分别作为独立步骤展示，可以在不等到执行时间的情况下确认「现在会不会跑」。

## 执行记录的性能

日志表是最容易失控的地方（秒级任务每天十万行、每行最多 100 KiB 正文），所以整条链路都按"日志再多也不卡"设计：

- **查询只取摘要**：列表接口不返回请求/响应体，展开某条时才拉 `/api/logs/:id`。
- **覆盖索引**：`idx_logs_summary`（列表与每任务指标）和 `idx_logs_metrics`（今日 / 近 7 天聚合）只含小列。没有它们时，SQLite 为了读到行尾的小列会把整行（含 40 KiB 正文）读一遍——实测 1.6 万条日志下指标接口要 648 ms，加覆盖索引后降到 16 ms，列表页从 24 ms 降到 1 ms。
- **只查保留窗口内的记录**：窗口由 `logRetentionDays` 决定（默认 30 天），窗口外的行连查询都不会发生。
- **渲染有上限**：页面最多同时渲染 300 条记录，再往前的记录不再加载（"加载更早"按钮会消失，并提示已达上限）；内存里的记录同样只保留这 300 条。
- **卡顿有感知**：每次重建列表都会计时，超过 120 ms 会在面板标题栏显示"渲染 N 条耗时 X ms"，不会静默地冻住。
- **后台分批清理**：保留策略每轮最多删 5000 行，避免一条大事务卡住单线程的整个服务。

## 运行统计

顶栏常驻一行概览：今日执行次数、近 7 天成功率、近 7 天平均耗时（有任务正在执行时还会显示「N 个执行中」）。点顶栏「统计」打开面板，里面是六个概览卡片（任务数、正在执行、今日执行、近 7 天执行、近 7 天成功率、近 7 天平均耗时）和一张按任务排列的表格：最近 N 次（默认 20）成功率、平均耗时、最近一次的结果。

- 成功 = 没有错误且状态码是 2xx；超时、被中断、5xx 都算失败。
- 每个任务只统计**最近 20 次**执行（`GET /api/metrics` 的 `window`），查询走 `(task_id, executed_at DESC)` 索引，是有界的索引扫描，不会全表扫描日志。
- 统计每 15 秒刷新一次（任务列表是 4 秒），统计请求失败时保留上一次的结果，不影响任务列表。

## 日志清理

页面上的「日志清理」先拉预检（`GET /api/logs/cleanup/preview`），展示数据库/WAL/SHM 占用、日志总数与时间范围，以及 10 天 / 30 天 / 半年 / 一年四档各自会删除的条数与估算字节，另有「全部清除」。

- 档位按 `logs.executed_at < now - N 天` 删除，不按任务区分、不保留每个任务的最近一条。
- 普通档位需勾选确认（`confirm: true`）；全部清除需输入「删除全部」并且请求带 `confirm: "DELETE_ALL"`。
- 删除后执行 `VACUUM` 与 WAL checkpoint，让文件真正缩小。`VACUUM` 在 Bun 单线程内同步执行，期间 HTTP 请求会排队，前端的 15 秒超时提示即针对此场景（清理请求本身用 10 分钟超时，不会被中途掐断）。
- 这次 `VACUUM` 会顺便把数据库切换成 `auto_vacuum=INCREMENTAL`：之后后台保留策略删掉的行由小批量回收逐步归还空间，不再需要长时间阻塞的全量 `VACUUM`。启动日志会提示当前数据库是否已启用。
- 清理是全局操作，不可撤销。预检返回的 `cutoff` 会随执行请求一起提交，后端按该截止时刻删除，保证「确认的条数 = 实际删除的条数」。`cutoff` 必须来自**对应档位**的预检：后端校验它落在该档位理论截止时刻的容差窗口内，防止用普通档位的 `confirm: true` 搭配放大的 `cutoff` 绕过「全部清除」的强二次确认；预检过期（超过 1 天）会被拒绝，需重新统计。

## curl 解析

支持（请求语义会真实生效）：

- 方法与请求体：`-X/--request`、`-H/--header`、`-d/--data/--data-raw/--data-binary/--data-ascii`、`--data-urlencode`、`--json`、`-G/--get`、`-I/--head`
- 常用头与认证：`-A/--user-agent`、`-e/--referer`、`-u/--user`（Basic）、`--oauth2-bearer`、`-r/--range`、`-b/--cookie`
- URL 与超时：`--url`、`--url-query`、`--max-time`（每个任务超时，覆盖全局 `requestTimeoutMs`）、`--connect-timeout`（没有 `--max-time` 时作为总超时回退）
- 传输选项：`-k/--insecure`（仅该任务把 Bun fetch 的 `tls.rejectUnauthorized` 设为 false）、`-L/--location`、`--location-trusted`、`--no-location`、`-x/--proxy`（http/https，也接受 `host:port`）、`-U/--proxy-user`（需配合 `-x`，Basic 代理认证通过 Bun 代理 headers 发送，不写入普通请求头/日志）
- 引号、双引号、反斜杠续行、`-XPOST` 这类紧贴取值、`--request=POST`
- 多个 `-d` 用 `&` 拼接；有 body 且未指定方法时默认 POST，并补充 `Content-Type: application/x-www-form-urlencoded`
- 浏览器「Copy as cURL」常见组合（`-H`、`-b`、`--compressed`、`--data-raw`、`--insecure`）可直接粘贴
- `-b/--cookie` 映射为 `Cookie` 头；多个值与已有 Cookie 头用 `; ` 合并（不含 `=` 的值视为文件路径并拒绝）
- `-G` 把 `-d/--data-urlencode` 放入 URL 查询串；`--url-query` 始终追加查询参数（`+` 前缀编码值）

兼容接受但**不会改变出站请求**的 flag（curl 自身的输出/重试/传输偏好）：

`-s/-S/-i/-v/-o/-O/-D/-w/-c/-C/-y/-Y/-z`、`--compressed`、`--retry/--retry-delay/--retry-max-time`、`--max-redirs`、`--http0.9/--http1.0/--http1.1/--http2/--http3`、`--tlsv1.0/--tlsv1.1/--tlsv1.2/--tlsv1.3`、`--fail/--fail-with-body`、`--globoff`、`--no-keepalive/--keepalive-time`、`--trace/--trace-ascii` 等。输出文件不会创建，重试不会由 curl 层执行；调度仍是每个窗口一次。

明确拒绝并报出参数名：

- multipart/上传：`-F/--form`、`-T/--upload-file`
- 自定义 TLS 证书/私钥：`--cacert`、`--capath`、`--cert`、`--key`、`-E` 等
- 网络/DNS 覆盖：`--resolve`、`--connect-to`、`--interface`、`--unix-socket`、`--dns-*`、`--noproxy`、`--proxy-header`
- 其他认证：`--digest`、`--ntlm`、`--negotiate`
- 配置文件/多请求：`-K/--config`、`--next`
- `-G/--get` 与 `--json` 同时使用（避免静默丢载荷）
- `@file` 请求体、未知 flag、非 http/https URL、GET/HEAD 携带 body

所有校验在**创建任务之前**完成；失败返回 400，不落库、不执行。整个项目不执行 shell 命令，不使用 `child_process`、`eval` 或 `new Function` 处理用户输入。

### 测试台（主要入口）

顶栏的「测试台」按钮、新建任务面板 curl 输入框旁的入口、以及每个任务卡片上的「测试」都能打开同一个弹窗。打开时会把当前表单（或该任务）的配置填进去，点「开始测试」后按**正式执行的顺序**跑一遍，并把每一步列成时间线：

1. **解析 curl**：展示最终会发出的 method / URL / 关键传输选项（超时、跳过 TLS、代理、重定向）；
2. **本地条件**（可选）：按当前时间判断星期/时段是否允许执行，不发任何请求；
3. **前置判断**（可选）：真的发出前置 curl，按状态码/表达式判定，并说明通过或失败的原因；
4. **主请求**：真的发出主 curl，展示状态码、耗时、响应头与响应体；
5. **成功条件判定**：逐项列出配置的条件（状态码、响应体、表达式）以及命中/未命中；
6. **通知**（可选）：命中才发；默认「演练模式」只显示将要发送的通知请求，不真正发出，勾选「实际发送通知」才会发。

因此测试台看到的是「过程 + 结果」，而不只是一次探测的响应。

- 弹窗底部「用这份配置建任务」会把测试内容写回表单（curl、执行前判断、成功条件、通知），并在名称为空时自动命名为「测试任务 MM-DD HH:mm」，然后按表单当前的调度方式直接创建；正在编辑已有任务时只回填、不新建，避免误改或误建。
- 从任务卡打开的测试台会带上 `task_id`：每次测试自动留档，弹窗里显示「最近测试」列表（最多 10 次），点一下就能回看那一次的完整步骤。
- 测试本身**不写执行记录**，不影响任务的调度与日志；只有任务维度的测试才会写 `test_runs` 留档，删任务时一并删除。
- curl 非法不会让接口报错：解析失败会作为第一步的失败原因展示在时间线上（`POST /api/test/run` 仍返回 200）。
- 每一步都可展开「请求 / 响应详情」，包含请求头、请求体、响应头、响应体（超过 `logBodyLimitBytes` 标记截断）。
- 传输方式与真实任务完全一致（连接重置重试、TLS/代理、`--max-time`、响应体上限）；主请求与前置请求各内置 30 秒兜底超时，前端另有 100 秒整体中止保护。
- 主请求和前置请求都会**真实发出**（例如 POST 打卡），只有通知默认不发送；请自行留意目标端点的副作用。
- 旧的 `POST /api/curl/test` 仍然保留（只发一次请求、返回 `{ result }`），供脚本或旧前端使用。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务列表（**只含卡片需要的字段**，不含 curl/请求体等大字段）；每条额外带 `running` / `running_since`（此刻是否正在执行）与 `schedule_error`（调度配置是否无法解析） |
| GET | `/api/tasks/:id` | 单个任务的完整配置（编辑表单与测试台按需拉取）；不存在返回 404 |
| POST | `/api/tasks` | 新建任务（curl 或结构化字段） |
| POST | `/api/tasks/reorder` | 保存任务列表的新顺序，body `{ ids: [...] }`（必须是现有任务的完整排列，缺项或含未知 id 返回 409） |
| PUT | `/api/tasks/:id` | 编辑已有任务（字段与创建接口相同；不存在返回 404） |
| DELETE | `/api/tasks/:id` | 删除任务及其全部日志；成功返回 `{ ok, id, deleted_logs }`，不存在返回 404 |
| POST | `/api/tasks/:id/stop` | 停止（幂等） |
| POST | `/api/tasks/:id/run` | 立即执行一次（不改定时计划、写日志、走前置判断、可能发通知）；在途重复调用返回 409，任务不存在返回 404 |
| POST | `/api/tasks/:id/resume` | 恢复；对暂停中的任务表示「取消暂停」并立即恢复调度 |
| POST | `/api/tasks/:id/pause` | 暂停 1–15 天（body：`{ days, starts_today? }`，`starts_today` 默认 `false`） |
| GET | `/api/tasks/:id/logs?limit=50&before=<executed_at>:<id>` | 按执行时间倒序分页（默认/上限来自配置），返回 `{ logs, has_more, retention_days }`；**每条只含摘要**（不含请求/响应体），且只返回保留窗口内的记录 |
| GET | `/api/logs/:id` | 单条日志详情（含请求/响应头与体，展开某条日志时才拉） |
| GET | `/api/config` | 前端可用的配置（分页、默认窗口、轮询、响应体上限） |
| GET | `/api/metrics` | 运行统计：`{ overview, tasks, window }`。overview 含任务数、正在执行数、今日/近 7 天执行次数、成功率与平均耗时；tasks 为每个任务最近 N 次（默认 20）的成功率、平均耗时与最近一次结果 |
| POST | `/api/settings` | 运行时改设置，当前支持 `{ logRetentionDays }`（0–3650 的整数，0 = 不限制）；非法值返回 400 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/curl/test` | 测试一段 curl：body `{ curl }`，解析并立即发送一次，返回 `{ result }`；curl 非法返回 400，目标请求失败仍为 200（错误在 `result.error`）。不创建任务、不写日志 |
| POST | `/api/test/run` | 测试台：解析 → 本地条件 → 前置判断 → 主请求 → 成功条件 → 通知，返回 `{ result: { steps, summary }, test_run_id }`；解析失败也返回 200（失败在第一步里）。`send_notify` 默认 false（只演练）；带 `task_id` 时这次结果会写入该任务的测试记录 |
| GET | `/api/tasks/:id/test-runs` | 该任务最近的测试记录摘要（最多 10 条，`{ runs: [{ id, created_at, ok, summary }] }`） |
| GET | `/api/test-runs/:id` | 单次测试详情（含 `steps` 时间线） |
| POST | `/api/schedule/preview` | 调度预览：body 为调度字段，返回 `{ ok, kind, description, next, window, jitter_minutes }`（默认接下来 7 次触发时刻，可用 `count` 调整到 1–20；`window.instant=true` 表示精确时间） |
| GET | `/api/logs/cleanup/preview` | 日志清理预检：总条数、占用、各档位可删条数与估算字节 |
| POST | `/api/logs/cleanup` | 执行清理；`{ days, confirm: true, cutoff? }` 或 `{ all: true, confirm: "DELETE_ALL" }` |

创建请求示例（curl 文本 + 每天窗口）：

```json
{
  "name": "每日签到",
  "mode": "curl",
  "curl": "curl -X POST 'https://example.com/checkin' -H 'Authorization: Bearer xxx'",
  "schedule_kind": "daily",
  "window_start": "10:10",
  "window_end": "10:20",
  "notify_enabled": true,
  "notify_curl": "curl -X POST 'https://notify.example/hook' -d 'checkin ok'",
  "expect_status": 200,
  "expect_body": "{\"ok\":true}",
  "expect_expr": "data.result.remindtype=0"
}
```

每天精确 18:00 执行，但在前后 5 分钟内随机（去掉 `daily_jitter_minutes` 或填 0 就是精确到 18:00 整）：

```json
{
  "name": "晚间签到",
  "mode": "curl",
  "curl": "curl -X POST 'https://example.com/checkin'",
  "schedule_kind": "daily",
  "window_start": "18:00",
  "window_end": "18:00",
  "daily_jitter_minutes": 5
}
```

固定间隔 + 指定首次执行时间 + 前置判断（只在工作日 09:00–18:00、且有 pending 记录时才执行）：

```json
{
  "name": "每 10 分钟检查一次",
  "mode": "curl",
  "curl": "curl -X POST 'https://example.com/process'",
  "schedule_kind": "interval",
  "interval_seconds": 600,
  "interval_jitter_seconds": 30,
  "interval_start_at": 1795165200000,
  "precheck_enabled": true,
  "precheck_weekdays": [1, 2, 3, 4, 5],
  "precheck_time_start": "09:00",
  "precheck_time_end": "18:00",
  "precheck_curl": "curl -s 'https://example.com/pending-count'",
  "precheck_expr": "data.pending>0",
  "precheck_expect_status": 200
}
```

- `schedule_kind` 省略时按 `daily` 处理，因此旧客户端不需要改动；非 daily 任务不校验 `window_*`。
- `schedule_kind` 只接受 `daily` / `interval`；传 `cron` 或其他值返回 400（Cron 表达式已整体移除）。
- 间隔也可以写成 `interval_value` + `interval_unit`（`1`/`60`/`3600`/`86400`）由前端换算，后端只接受 `interval_seconds`。
- `daily_jitter_minutes` 只在 `window_start === window_end`（精确时间）时有效，必须是 0–60 的整数；配到普通时间范围会返回 400。
- `interval_start_at` 是 epoch 毫秒，可以填过去的时间（按该时刻对齐，第一次落在下一个整点），也可以填未来时间（第一次就是它）。留空或省略表示从创建时刻开始算。
- `precheck_weekdays` 接受数组或逗号分隔的 `0`–`6`（0 = 周日）；`precheck_time_start` / `precheck_time_end` 必须成对出现，结束早于开始表示跨午夜。`precheck_enabled: true` 时至少要配本地条件或前置 curl 之一。
- `expect_status` / `expect_body` / `expect_expr` 与 `notify_enabled` 无关，始终保存并用于记录「命中」。
- 结构化模式使用 `mode: "structured"` + `url`、`method`、`headers`（多行文本或 JSON 对象）、`body`；前置判断同样支持 `precheck_url`、`precheck_method`、`precheck_headers`、`precheck_body`。

## 数据模型

在需求给定结构上增加了通知、调度方式、执行前判断（本地条件 + 前置 curl）、命中条件、测试留档与日志分类字段：

- `tasks`：`schedule_kind`（`daily` / `interval`，默认 `daily`）、`daily_jitter_minutes`（精确时间的 ± 分钟，默认 0）、`interval_seconds`、`interval_jitter_seconds`、`interval_start_at`（首次执行时间，可空）；`sort_order`（任务列表的手动顺序，越小越靠前；旧库升级时按"最新在前"回填，新任务默认插到最前）；`precheck_enabled`、`precheck_curl_command`、`precheck_url/method/headers/body/options`、`precheck_expect_status`、`precheck_expr`、`precheck_weekdays`（`0`–`6` 逗号串）、`precheck_time_start` / `precheck_time_end`；`notify_enabled`、`notify_curl_command`、`notify_url/method/headers/body`、`expect_status`、`expect_body`、`expect_expr`、`request_options` / `notify_options`（JSON：`insecure`、`redirect`、`timeoutMs`、`proxy`、`proxyAuthorization`），以及暂停区间 `paused_from` / `paused_until`（本地日 00:00 的毫秒时间戳，半开区间 `[from, until)`）
- `logs`：`kind`（`task` / `notify` / `missed` / `skipped`）、`parent_log_id`、`matched`。`skipped` 记录的 `request_*` / `response_*` 属于前置判断请求（本地条件跳过时为空），`error` 说明跳过原因；`missed` 的原计划时刻写在 `error` 里
- `test_runs`：测试台留档，`task_id`、`created_at`、`ok`、`summary`（JSON）、`steps`（JSON 时间线）；每个任务只保留最近 10 条，插入时自动清理更早的，删除任务时一并删除
- `settings`：键值对，存运行时可改的设置（当前只有 `logRetentionDays`）。它在配置文件之上生效：清空该项即回到配置文件的默认值。

### 旧库升级

所有结构变化都是**增量列**（`ALTER TABLE ... ADD COLUMN`，带默认值），启动时自动执行，不需要手工迁移或备份表：

1. 老任务的 `schedule_kind` 得到默认值 `daily`，`window_start` / `window_end` 原样保留（都不相等，所以仍是「时间范围」），`daily_jitter_minutes` 为 0——调度行为与升级前完全一致；
2. 旧库里 `schedule_kind = 'cron'` 的任务会被改为 `daily`：有有效窗口的保留窗口，没有窗口的填 `00:00–00:05` 占位，启动日志会列出这些任务名，请到页面确认执行时间（Cron 表达式本身已无处可解析）；
3. `interval_*` / `interval_start_at` 为空（循环任务按原计划继续；新任务留空表示从现在开始算），`precheck_enabled` 为 `0`（无执行前判断），`precheck_weekdays` / `precheck_time_*` 为空（不限星期与时段）；
4. 旧日志不受影响，只是新增了 `skipped` 这种取值；
5. `test_runs` 表会被自动创建（空表），旧数据不迁移；
6. 升级前的暂停记录仍按原有的 `paused_from` 回填规则处理（见「暂停」）。

旧的 `cron_expr` 列不会再被读写；SQLite 不支持无损删列，保留它对运行没有任何影响。

升级后建议在页面上逐个打开任务点「编辑」确认一遍调度方式，再点一次「测试台」验证链路——这两步都不改变运行中的任务。

`data/` 整个目录已被 `.gitignore` 忽略。日志按 `logRetentionDays`（默认 30 天）自动清理，也可以随时用「日志清理」手动清理。

## 安全与已知限制

- 默认仅监听 `127.0.0.1`；`host` 也可设为 `0.0.0.0`（Docker 方案即如此）。无论哪种都没有登录/鉴权，不要直接暴露到公网。
- 日志会原样保存请求头与请求体，可能包含 token、Cookie 等敏感信息。
- 进程内调度依赖服务常驻；服务停止期间错过的窗口不会补跑，只记录 `missed` 日志。
- 执行过程中崩溃重启时，如果请求已发出但尚未完成落库，重启后可能再次执行一次（窗口内恢复语义）。
- 请求默认 30 秒超时（`requestTimeoutMs`），可用 curl 的 `--max-time` 按任务覆盖；超时记为 `aborted=1`，错误为“请求超时”。超时后任务自动恢复调度，不会因为一次挂死的请求而永久停摆；请求进行期间卡片显示“执行中 · 已 x 秒”，点“停止”可立即中断。
- **连接重置自动重试**：Bun 的 fetch 会复用 keep-alive 连接，远端（CDN 等）可能单方面关闭空闲 socket，下一次请求写进去时收到 `ECONNRESET`，且发生在响应头之前。执行器对这类连接重置错误（`ECONNRESET` / `EPIPE` / “socket connection was closed unexpectedly” 等）自动重试最多 2 次（共 3 次），重试请求带 `Connection: close` 强制换一条新连接，退避带抖动且可随时被停止/超时中止。只对响应头之前的 `fetch()` 阶段重试，body 读取出错不重试，避免对有副作用的 POST 重复发送；DNS/TLS/HTTP 状态码等非重置错误不重试。这正是间隔很长的通知任务偶发失败的主因，重试后通常即可成功。
- `-k/--insecure` 会为该任务关闭 TLS 证书校验（Bun fetch `tls.rejectUnauthorized=false`），任务卡片会显示“跳过 TLS 校验”；仅对可信内网或自签名测试端点使用。
- `-x/--proxy` 会让请求经指定代理发出；未指定时 Bun fetch 仍会读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量。`-U/--proxy-user` 必须配合 `-x`，凭据通过 Bun 代理 headers 发送，不写入普通请求头或日志；代理 URL 中的 userinfo 会被剥离并转换为同一份代理认证。
- **失效代理自动回退直连**：长期运行的进程（如 PM2）可能继承到过期代理——代理软件换了本地端口但进程没重启，浏览器用系统新代理正常、Jitter 却卡在旧端口直到超时。未指定 `-x` 且存在环境代理时，首次请求用 8 秒探测窗口；若因超时挂起，则清除本进程的环境代理变量并直连重试一次，成功后保持直连（后续请求即恢复快速），失败则恢复原代理。显式 `-x` 视为用户明确选择，不做回退。回退会在控制台打印告警。
- curl 文本、任务配置和日志可能包含 Authorization、Cookie 等敏感信息；请限制数据目录权限，不要把实例暴露到公网。
- 编译后的单文件在执行目录/可执行文件目录查找 `jitter.config.json`；服务化时应显式设置 `JITTER_CONFIG` 和 `JITTER_DB_PATH` 到可写目录。
- 输出、重试、协议偏好类 flag 会被接受但不会改变出站请求：不写文件、不执行 curl 层重试（上述「连接重置自动重试」属执行器的传输容错，与 curl 的 `--retry` 无关），任务仍按窗口调度一次。
- 不支持 multipart/文件上传、自定义 TLS 证书文件、DNS/连接覆盖（见上文拒绝列表）。
- `daily` 的一个窗口只执行一次；循环执行按自己的节奏执行，且不会为一个计划时刻重复执行。「立即执行」是额外的手动一次，不占用也不改动既有计划。请求在途期间不会进入下一次调度，被长请求跨过的那一拍**静默跳过**（循环执行从当前时刻重新起算，不补跑，也不写日志）。
- `missed` 日志的 `executed_at` 是写入时刻，原计划时刻写在错误信息里（否则宕机数日后启动补写的日志会立刻落在清理档位之外）。
- 响应正文默认最多保存/比较 100 KiB，可由 `logBodyLimitBytes` 调整；二进制响应按 UTF-8 解码显示。
- 日志表默认保留 30 天（`logRetentionDays`），可设 `0` 永不自动清理；数据库文件不会立刻缩小，靠 `auto_vacuum=INCREMENTAL` 小批量回收，磁盘占用下降是渐进的。
- 通知 curl 是固定请求，不做模板变量替换。
- 所有时间按运行机器的本地时区计算；DB 存毫秒时间戳。窗口边界按本地挂钟推进，在实行夏令时且切换点落在午夜附近的时区，跨午夜窗口的绝对时长可能偏移约 1 小时；暂停按自然日计算不受此影响。
- 时间窗口精度为分钟；`daily` 不支持秒级窗口或跨多天窗口。需要秒级节奏请把循环间隔设为 1 秒。
- 精确时间的实际触发会有秒级延迟；晚到 60 秒内算按时，超过则记 `missed` 并等次日。抖动范围靠近午夜时会被截断到当天。
- 秒级/分钟级任务在进程休眠、系统时间跳变或事件循环阻塞后会迟到：迟到超过容差记 `missed` 并重排，不补执行；因此不保证「每一秒都恰好执行一次」。
- 执行前判断失败（本地条件不满足、前置 curl 失败或条件不成立）都只跳过本次并写一条 `skipped` 记录，不会自动重试；如果需要「重试到成功」，请把判断写进主请求的目标系统，或使用较密的间隔。
- 本地条件按本机时区与分钟精度判断；跨午夜时段（如 22:00–02:00）按开始那天归属星期，00:30 属于前一天。
- 测试台的留档是「每任务最近 10 次」的环形保留，超出即丢弃最旧的；每条包含完整步骤和响应体，响应体较大时会占用相应空间。
- 测试台的主请求与前置请求都会真实发出（只有通知默认演练），不要把只读测试当成「安全预演」。

## 部署与打包

Jitter 的调度 timer 和 SQLite 都在进程内，**必须单实例运行**；进程管理只负责常驻和崩溃重启。

### PM2（跨平台）

```bash
npm i -g pm2        # 或 bun add -g pm2
cd /path/to/jitter
pm2 start bun --name jitter -- run src/index.ts
pm2 save
```

- 也可以 `pm2 start ecosystem.config.cjs`（已设为 `instances: 1`、fork 模式）。
- Linux/macOS 开机自启：执行 `pm2 startup` 后运行它打印的命令，再 `pm2 save`。
- Windows：`pm2 startup` 不可用，使用 `pm2-installer`、任务计划程序或 NSSM 在登录/开机时执行 `pm2 resurrect`。
- 不要让 PM2 使用 cluster 模式：会重复执行 timer 并竞争 SQLite。

### systemd（Linux）

```ini
[Unit]
Description=Jitter
After=network.target

[Service]
WorkingDirectory=/opt/jitter
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=2
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now jitter`。如果使用编译后的二进制，把 `ExecStart` 改成 `/opt/jitter/jitter`。

### Docker / Compose

```bash
docker compose up -d --build
```

- 容器内使用 `HOST=0.0.0.0`、`PORT=3000`（Compose 已设置），只把端口发布到 `127.0.0.1:3000`。
- `data` 使用命名卷；SQLite WAL 需要本地可写文件系统，不要放在 NFS 上；只跑一个副本。
- 固定端口映射时，把 `jitter.config.json` 的 `autoIncrementPort` 改为 `false`，否则端口被占用时容器内部会换端口而外部映射仍指向旧端口。
- 配置文件通过 `-v ./jitter.config.json:/app/jitter.config.json:ro` 挂载；数据库路径用 `JITTER_DB_PATH` 覆盖。
- Dockerfile 基于 `oven/bun:1.4.4`，构建时使用 `bun install --frozen-lockfile`。

### 单文件打包

```bash
bun run build
```

- 生成 `dist/jitter`（Windows 为 `dist/jitter.exe`），内嵌 Bun 运行时、Elysia、后端和前端 HTML/JS；约 116 MB。
- 把可执行文件和 `jitter.config.json` 放在同一目录（或从该目录启动）；程序会在启动目录和可执行文件目录查找配置，也支持 `JITTER_CONFIG` / `JITTER_DB_PATH` / `PORT` 覆盖。
- 交叉编译示例：`bun build --compile --target=bun-linux-x64 --outfile dist/jitter-linux src/index.ts`（也支持 `bun-darwin-arm64`、`bun-windows-x64` 等）。
- 打包后目标机不需要 `bun install`；数据库仍在外部 `data/` 目录，升级二进制不会丢历史日志。

### 持续部署

PM2 / systemd / Docker 只负责“常驻 + 崩溃重启”；持续部署需要拉代码、测试、构建、重启的流水线，例如：

```bash
git pull --ff-only
bun install --frozen-lockfile
bun test
pm2 restart jitter --update-env
```

Docker 流程为：构建并推送新镜像 → 目标机 `docker compose pull && docker compose up -d`。GitHub Actions 可以复用同样的 `bun install` / `bun test` / `bun run build`，部署步骤按服务器选择 SSH 或镜像仓库。

## 目录

```text
jitter.config.json    # 默认配置（可用 JITTER_CONFIG 覆盖）
ecosystem.config.cjs  # PM2 单实例配置
Dockerfile            # 容器镜像（oven/bun:1.4.4）
docker-compose.yml    # 命名卷 + 本地端口映射
.dockerignore
dist/                 # bun run build 产物（gitignore）
src/
├── index.ts          # Bun.serve + HTML 路由 + 配置/端口启动 + 退出
├── api.ts            # Elysia API、创建前校验、测试台、测试留档、调度预览、错误映射
├── config.ts         # 配置默认值、JSON 加载、校验、环境变量覆盖、编译态路径
├── port.ts           # EADDRINUSE 检测、端口 +1 重试、本机地址校验
├── db.ts             # SQLite/WAL、建表、增量迁移、预编译语句、任务 / 日志 / 测试留档读写
├── scheduler.ts      # 定时 / 循环计划 + 随机 timer + 巡检 + 恢复 + 停止/恢复 + 立即执行 + 删除 + 代际防护
├── schedule.ts       # 定时（窗口/精确/抖动）/ 循环（间隔）的计划、暂停跳过、预览（纯函数）
├── metrics.ts        # 运行统计：每个任务最近 N 次成功率/平均耗时 + 今日与近 7 天概览
├── guard.ts          # 执行前判断的本地条件（星期 / 时段，跨午夜按开始日归属）
├── window.ts         # 跨午夜窗口、随机点、恢复矩阵（纯函数）
├── executor.ts       # fetch + AbortController + 连接重置重试 + 失效代理自愈直连 + TLS/代理/超时 + 100 KiB 截断 + 执行前判断 + 通知
├── testbench.ts      # 测试台链路：解析 → 本地条件 → 前置判断 → 主请求 → 判定 → 通知
├── condition.ts      # 条件表达式（成功条件与前置条件共用）的安全解析与求值（无 eval）
├── curl-parser.ts    # shell 风格 tokenizer + 宽 curl 参数映射
├── types.ts
├── *.test.ts         # bun test
└── frontend/
    ├── index.html
    └── app.js
```

## 验收对照

1. `bun install && bun run src/index.ts` 启动并打印地址。
2. 页面新建窗口为“当前时间 +1 分钟”的任务，等待随机触发，日志显示完整请求/响应。
3. 在 `next_run_at` 之前重启服务，任务仍按原定时间触发（实测恢复日志：`已恢复 N/N 个 active 任务`）。
4. 对慢请求执行中点击“停止”：请求中断，日志 `aborted=1`，任务 `next_run_at` 为 NULL，不再调度。
5. 日志按任务分页、按执行时间倒序返回（最新在最上面），前端“加载更早”使用 `before=<executed_at>:<id>` 复合游标。
6. `grep -R "child_process\|eval(\|new Function" src` 无业务命中；无 shell 调用。
7. 顶栏「统计」能看到今日执行次数、近 7 天成功率与每个任务最近 20 次的成功率/平均耗时。
8. 卡住的目标地址会在 `requestTimeoutMs`（默认 30 秒）后超时并写日志，卡片上的「执行中」徽标会一直走秒，超时后任务自动恢复调度。
9. README 已写明启动方式、调度语义与限制。

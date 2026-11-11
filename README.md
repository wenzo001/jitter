# Jitter

在时间窗口里随机醒来，替你执行 curl。

Jitter 是一个本地任务调度工具：每天在用户给定的时间窗口内随机挑一个时刻，执行一条 curl 请求；所有请求与响应长期写入 SQLite，页面按任务查看聊天式历史；任务可以随时停止并中断正在进行的请求。

## 技术栈

| 层 | 选择 |
|---|---|
| 运行时 | Bun 1.4.4（已验证 `Bun.cron`、HTML import、`Bun.serve` routes） |
| 后端 | Elysia 1.4.31（与 `Bun.serve` 同进程；未回退 Hono） |
| 数据库 | `bun:sqlite`，`PRAGMA journal_mode = WAL` |
| 调度 | `Bun.cron`（每天窗口起点）+ `setTimeout`（窗口内随机偏移） |
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
bun test            # 170 项核心逻辑 / curl / 配置 / 调度 / API / 数据库 / 执行器测试
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
| `requestTimeoutMs` | `0` | 默认请求超时；curl 的 `--max-time` 可按任务覆盖 |
| `shutdownGraceMs` | `150` | SIGINT/SIGTERM 后等待在途中断日志落库的时间 |
| `defaultWindowMinutes` | `5` | 新建任务表单的默认窗口时长 |
| `pollIntervalMs` | `4000` | 前端刷新任务/日志的轮询间隔 |

- 未知配置项、错误类型或越界值会在启动时直接报错，不会静默回退；`$schema` 可作为编辑器元数据忽略。
- `JITTER_CONFIG` 的相对路径相对于进程工作目录；`JITTER_DB_PATH` 的相对路径也相对于工作目录；配置文件中的 `dbPath` 相对路径相对于配置文件目录。
- 端口占用自动重试：只对 `EADDRINUSE` 生效，按 `port + 1` 继续尝试，最多 `portMaxAttempts` 个端口；每次重试和最终切换都会打印。其他启动错误不重试；全部端口占用时以清晰错误退出。`autoIncrementPort: false` 时首次占用即失败。
- 前端通过 `GET /api/config` 获取 `logsPageSize`、`defaultWindowMinutes`、`pollIntervalMs`、`logBodyLimitBytes`，用于默认窗口、日志分页、轮询和响应体上限提示。
- `requestTimeoutMs > 0` 时，超时会写入 `aborted=1` 和 `error="请求超时（N ms）"`，随后按正常流程规划下一次执行；`0` 表示保持长时间请求，直到完成或手动停止。单个任务可用 curl 的 `--max-time` 覆盖。

## 调度语义

### 窗口归属

窗口使用本地时区的 `HH:mm`，**按开始日归属**。例如窗口 `23:50–00:10` 属于开始日 D，随机时刻可能落在 D 的 23:50–23:59，也可能落在 D+1 的 00:00–00:10；每次窗口只执行一次。

- `window_end > window_start`：当天窗口。
- `window_end < window_start`：跨午夜窗口，时长按跨天计算。
- 起止相同会被拒绝。

### 规划与恢复

每个 active 任务在稳定状态下都有 `next_run_at`，并最多有一个已武装的 timer（执行中的瞬间会暂时保留已执行的目标，结束后再规划）：

1. 新建 / 恢复：若当前在窗口内，在 `[now, 窗口结束)` 随机；否则在下一个窗口内随机。
2. 窗口起点的每日 cron 负责兜底：已有落在本窗口内的未来计划就保留，否则重新规划。
3. 执行结束后规划下一个窗口（跨午夜任务自动落到下一个开始日）。
4. 启动恢复：
   - `next_run_at` 在未来：原样恢复 timer。
   - 已过但仍在当前窗口内：在剩余窗口重新随机。
   - 窗口已关闭：写入一条 `kind='missed'` 日志（**不补跑**），再规划下一个窗口。
   - 当前早于今天窗口：规划今天。
5. timer 触发时会重新读取 DB，确认任务仍为 `active`、`next_run_at` 仍是本次目标；每次重规划/停止/恢复都会递增内存中的 generation，旧 timer 与旧执行回调自动失效。如果触发时窗口已经结束（例如机器休眠后 timer 迟到），按错过处理并记录 `missed`，不会越过窗口补执行。

### 停止

停止任务会同时：

1. 停止 `Bun.cron` 句柄并清除 `setTimeout`；
2. `abort()` 正在进行的请求；
3. 写入 `status='stopped', next_run_at=NULL`；
4. 保留全部历史日志。

正在进行的请求被中断后，会在日志中记录 `aborted=1`、`error="请求已中断"`。停止后的任务不再被调度；恢复会重新规划并注册 cron。

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
- 暂停是 `active` 任务的属性，`status` 仍为 `active`；每日 cron 继续存在，用于暂停期间的兜底规划和恢复日重新规划。设置暂停时，起算日之前已经排好的计划保持不变；启动恢复同样保留它。
- 取消暂停（`resume`）清除区间并立即重新规划；停止任务也会清除暂停标记；暂停过期后由 cron / timer / 启动恢复自动清理。
- 暂停不中断已经发出的请求，该请求正常完成并写日志，之后再按暂停规则规划下一次。
- 旧版本只存 `paused_until`，无法还原起算日（也正是「从明天开始却跳过今天下午」这个 bug 的根源）。`updated_at` 会被每次 cron / timer 重规划改写，不能用来推断设置时刻。升级时改用确定性规则：已过期的直接清除；仍有效的保留原恢复时刻，把 `paused_from` 设为**升级当天 00:00**，并清掉旧代码错误推到恢复日的 `next_run_at`，由调度器按新区间重新排期。仍有效的暂停必然覆盖升级当天，因此未来的暂停日与原意完全一致；唯一偏差是「设置当天就升级且选了从明天开始」会多暂停当天，启动日志会提示重新设置一次暂停。

## 成功通知

新建任务时可额外配置“成功通知”：

- **通知 curl**：命中成功条件后执行的第二条请求（同样使用解析器校验、无 shell）。
- **成功条件**（可组合，全部满足才算命中）：
  - 期望状态码（100–599，可选）
  - 期望响应体（与响应正文**完全相等**，可选；留空表示不启用，暂不支持只匹配空响应体）
  - 两项都不填时，任意 `2xx` 视为成功。
- 命中后执行通知 curl，并写入一条 `kind='notify'` 日志，`parent_log_id` 指向主请求日志。
- 未命中则不发送通知。
- 通知请求失败只影响自己的日志，不影响主任务。
- 响应用于比较和存储的正文上限由 `logBodyLimitBytes` 决定（默认 100 KiB）；超过上限会追加 `[truncated]`，且此时“期望响应体”视为不匹配。

错过窗口只写 `kind='missed'` 日志并在启动时打印提示，不补跑，也不会触发成功通知（通知只用于成功命中）。

## 日志清理

页面上的「日志清理」先拉预检（`GET /api/logs/cleanup/preview`），展示数据库/WAL/SHM 占用、日志总数与时间范围，以及 10 天 / 30 天 / 半年 / 一年四档各自会删除的条数与估算字节，另有「全部清除」。

- 档位按 `logs.executed_at < now - N 天` 删除，不按任务区分、不保留每个任务的最近一条。
- 普通档位需勾选确认（`confirm: true`）；全部清除需输入「删除全部」并且请求带 `confirm: "DELETE_ALL"`。
- 删除后执行 `VACUUM` 与 WAL checkpoint，让文件真正缩小。`VACUUM` 在 Bun 单线程内同步执行，期间 HTTP 请求会排队，前端的 15 秒超时提示即针对此场景。
- 清理是全局操作，不可撤销；预检只是快照，执行前可重新统计。

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

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 新建任务（curl 或结构化字段） |
| POST | `/api/tasks/:id/stop` | 停止（幂等） |
| POST | `/api/tasks/:id/resume` | 恢复；对暂停中的任务表示「取消暂停」并立即恢复调度 |
| POST | `/api/tasks/:id/pause` | 暂停 1–15 天（body：`{ days, starts_today? }`，`starts_today` 默认 `false`） |
| GET | `/api/tasks/:id/logs?limit=50&before=<id>` | 倒序游标分页（默认/上限来自配置），返回 `{ logs, has_more }` |
| GET | `/api/logs/:id` | 单条日志详情 |
| GET | `/api/config` | 前端可用的配置（分页、默认窗口、轮询、响应体上限） |
| GET | `/api/health` | 健康检查 |
| GET | `/api/logs/cleanup/preview` | 日志清理预检：总条数、占用、各档位可删条数与估算字节 |
| POST | `/api/logs/cleanup` | 执行清理；`{ days, confirm: true }` 或 `{ all: true, confirm: "DELETE_ALL" }` |

创建请求示例（curl 文本）：

```json
{
  "name": "每日签到",
  "mode": "curl",
  "curl": "curl -X POST 'https://example.com/checkin' -H 'Authorization: Bearer xxx'",
  "window_start": "10:10",
  "window_end": "10:20",
  "notify_enabled": true,
  "notify_curl": "curl -X POST 'https://notify.example/hook' -d 'checkin ok'",
  "expect_status": 200,
  "expect_body": "{\"ok\":true}"
}
```

结构化模式使用 `mode: "structured"` + `url`、`method`、`headers`（多行文本或 JSON 对象）、`body`。

## 数据模型

在需求给定结构上增加了通知与日志分类字段：

- `tasks`：`notify_enabled`、`notify_curl_command`、`notify_url/method/headers/body`、`expect_status`、`expect_body`、`request_options` / `notify_options`（JSON：`insecure`、`redirect`、`timeoutMs`、`proxy`、`proxyAuthorization`），以及暂停区间 `paused_from` / `paused_until`（本地日 00:00 的毫秒时间戳，半开区间 `[from, until)`）
- `logs`：`kind`（`task` / `notify` / `missed`）、`parent_log_id`、`matched`

`data/` 整个目录已被 `.gitignore` 忽略。日志无自动清理，长期保留。

## 安全与已知限制

- 仅监听 `127.0.0.1`，没有登录/鉴权；不要直接暴露到公网。
- 日志会原样保存请求头与请求体，可能包含 token、Cookie 等敏感信息。
- 进程内 cron 依赖服务常驻；服务停止期间错过的窗口不会补跑，只记录 `missed` 日志。
- 执行过程中崩溃重启时，如果请求已发出但尚未完成落库，重启后可能再次执行一次（窗口内恢复语义）。
- 请求默认没有超时；可通过全局 `requestTimeoutMs` 或 curl 的 `--max-time` 启用（超时记为 `aborted=1`，错误为“请求超时”）。在请求结束或停止之前，该任务不会进入下一次调度。
- `-k/--insecure` 会为该任务关闭 TLS 证书校验（Bun fetch `tls.rejectUnauthorized=false`），任务卡片会显示“跳过 TLS 校验”；仅对可信内网或自签名测试端点使用。
- `-x/--proxy` 会让请求经指定代理发出；未指定时 Bun fetch 仍会读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量。`-U/--proxy-user` 必须配合 `-x`，凭据通过 Bun 代理 headers 发送，不写入普通请求头或日志；代理 URL 中的 userinfo 会被剥离并转换为同一份代理认证。
- curl 文本、任务配置和日志可能包含 Authorization、Cookie 等敏感信息；请限制数据目录权限，不要把实例暴露到公网。
- 编译后的单文件在执行目录/可执行文件目录查找 `jitter.config.json`；服务化时应显式设置 `JITTER_CONFIG` 和 `JITTER_DB_PATH` 到可写目录。
- 输出、重试、协议偏好类 flag 会被接受但不会改变出站请求：不写文件、不执行 curl 层重试，任务仍按窗口调度一次。
- 不支持 multipart/文件上传、自定义 TLS 证书文件、DNS/连接覆盖（见上文拒绝列表）。
- 一个窗口只执行一次；不提供手动立即执行。
- 响应正文默认最多保存/比较 100 KiB，可由 `logBodyLimitBytes` 调整；二进制响应按 UTF-8 解码显示。
- 通知 curl 是固定请求，不做模板变量替换。
- 所有时间按运行机器的本地时区计算；DB 存毫秒时间戳。
- 时间窗口精度为分钟；不支持秒级窗口或跨多天窗口。

## 部署与打包

Jitter 的 cron、timer 和 SQLite 都在进程内，**必须单实例运行**；进程管理只负责常驻和崩溃重启。

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
- 不要让 PM2 使用 cluster 模式：会重复执行 cron/timer 并竞争 SQLite。

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
├── api.ts            # Elysia API、创建前校验、/api/config、错误映射
├── config.ts         # 配置默认值、JSON 加载、校验、环境变量覆盖、编译态路径
├── port.ts           # EADDRINUSE 检测、端口 +1 重试、本机地址校验
├── db.ts             # SQLite/WAL、建表、增量迁移、预编译语句、任务与日志读写
├── scheduler.ts      # cron + 随机 timer + 恢复 + 停止/恢复 + 代际防护
├── window.ts         # 跨午夜窗口、随机点、恢复矩阵（纯函数）
├── executor.ts       # fetch + AbortController + TLS/代理/超时 + 100 KiB 截断 + 通知
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
5. 日志按任务分页倒序返回，前端“加载更早”使用 `before` 游标。
6. `grep -R "child_process\|eval(\|new Function" src` 无业务命中；无 shell 调用。
7. README 已写明启动方式、调度语义与限制。

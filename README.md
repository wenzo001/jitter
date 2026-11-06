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

控制台会打印访问地址（默认 `http://127.0.0.1:3000/`）、数据库位置和恢复的任务数。

环境变量：

- `PORT`：监听端口，默认 `3000`
- `HOST`：监听地址，默认 `127.0.0.1`
- `JITTER_DB_PATH`：SQLite 路径，默认 `data/app.db`（目录会自动创建）

其他命令：

```bash
bun test            # 84 项核心逻辑 / 调度 / API / 数据库 / 执行器测试
bun run typecheck   # tsc --noEmit
```

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
- 响应用于比较和存储的正文上限为 100 KiB；超过上限会追加 `[truncated]`，且此时“期望响应体”视为不匹配。

错过窗口只写 `kind='missed'` 日志并在启动时打印提示，不补跑，也不会触发成功通知（通知只用于成功命中）。

## curl 解析

支持：

- `-X/--request`、`-H/--header`、`-d/--data/--data-raw/--data-binary/--data-ascii`、`--url`
- 单引号、双引号、反斜杠续行、`-XPOST` 这类紧贴取值、`--request=POST`
- 多个 `-d` 按 curl 语义用 `&` 拼接；有 body 且未指定方法时默认 POST，并补充 `Content-Type: application/x-www-form-urlencoded`
- 不改变出站语义的 `-s/-S/-i/-v/--compressed/-L`

明确拒绝并报出参数名：

- `@file` 请求体、`-u`、`-k`、`-F/--form`、`-G`、`-b`、`--proxy`、`--max-time`、`--data-urlencode` 等无法等价映射的项
- 未知 flag
- 非 http/https URL
- GET/HEAD 携带 body

所有校验在**创建任务之前**完成；失败返回 400，不落库、不执行。整个项目不执行 shell 命令，不使用 `child_process`、`eval` 或 `new Function` 处理用户输入。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 新建任务（curl 或结构化字段） |
| POST | `/api/tasks/:id/stop` | 停止（幂等） |
| POST | `/api/tasks/:id/resume` | 恢复 |
| GET | `/api/tasks/:id/logs?limit=50&before=<id>` | 倒序游标分页，返回 `{ logs, has_more }` |
| GET | `/api/logs/:id` | 单条日志详情 |
| GET | `/api/health` | 健康检查 |

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

- `tasks`：`notify_enabled`、`notify_curl_command`、`notify_url/method/headers/body`、`expect_status`、`expect_body`
- `logs`：`kind`（`task` / `notify` / `missed`）、`parent_log_id`、`matched`

`data/` 整个目录已被 `.gitignore` 忽略。日志无自动清理，长期保留。

## 安全与已知限制

- 仅监听 `127.0.0.1`，没有登录/鉴权；不要直接暴露到公网。
- 日志会原样保存请求头与请求体，可能包含 token、Cookie 等敏感信息。
- 进程内 cron 依赖服务常驻；服务停止期间错过的窗口不会补跑，只记录 `missed` 日志。
- 执行过程中崩溃重启时，如果请求已发出但尚未完成落库，重启后可能再次执行一次（窗口内恢复语义）。
- 请求本身没有内置超时；长时间挂起的请求可用“停止”中断。在请求结束或停止之前，该任务不会进入下一次调度。
- 一个窗口只执行一次；不提供手动立即执行。
- 响应正文最多保存/比较 100 KiB；二进制响应按 UTF-8 解码显示。
- 通知 curl 是固定请求，不做模板变量替换。
- 所有时间按运行机器的本地时区计算；DB 存毫秒时间戳。
- 时间窗口精度为分钟；不支持秒级窗口或跨多天窗口。

## 目录

```text
src/
├── index.ts          # Bun.serve + HTML 路由 + 启动/退出
├── api.ts            # Elysia API、创建前校验、错误映射
├── db.ts             # SQLite/WAL、建表、预编译语句、任务与日志读写
├── scheduler.ts      # cron + 随机 timer + 恢复 + 停止/恢复 + 代际防护
├── window.ts         # 跨午夜窗口、随机点、恢复矩阵（纯函数）
├── executor.ts       # fetch + AbortController + 100 KiB 截断 + 成功判定 + 通知
├── curl-parser.ts    # shell 风格 tokenizer + curl 参数映射
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

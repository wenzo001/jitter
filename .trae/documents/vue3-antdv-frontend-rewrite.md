# Vue 3 + antdv-next 前端重建计划

## Context

当前前端是 `src/frontend/index.html`（内联 CSS + 所有弹窗）与 `src/frontend/app.js`（约 138KB 原生 JS），由 Rust 通过 `include_str!` 嵌入单文件二进制。表单校验散落在提交函数里，条件配置和高级选项堆在一屏，用户容易迷路；任务卡上的「执行条件」徽标也没有解释。

本次按第一性原理重建全部界面：Vue 3 + TypeScript + antdv-next + Vite，任务表单改为「单页分区 + 固定操作栏」，所有表单明确必填/可选、支持取消与保存、错误就地提示；任务卡的「执行条件」提供悬浮/聚焦/点击弹出的条件清单。**后端 API、数据库结构和请求字段保持不变**，只调整静态资源服务与前端实现。

已确认：全量重建，不保留旧 vanilla 前端的 DOM ID 兼容层；任务表单采用单页分区，不做多步向导。

## 技术决策

- Vue 3 + TypeScript + Vite，`antdv-next`（npm 包名）组件库，Pinia 管理跨组件状态。
- 目录独立为 `web/`，与 Bun 参考后端解耦；Rust 仍是主发布目标。
- Vite 输出 `web/dist`，Rust 用 `include_dir` 嵌入；不提交 dist，由 CI 构建并作为 artifact 传递给 Rust 构建。
- 保留现有浅色视觉与绿色强调色，通过 `a-config-provider` 主题 token 映射，不直接照搬 antd 默认蓝。
- 任务提交继续使用 snake_case 字段；只把任务响应原样映射为 TS 类型，禁止在适配层改字段名。
- Bun 版只做最小静态服务适配（读取 `web/dist`），不追新功能，符合逐步停维护的方向。

## 目录与组件

```
web/
  package.json vite.config.ts tsconfig.json index.html
  src/main.ts App.vue
  src/api/        client.ts tasks.ts logs.ts testbench.ts settings.ts system.ts backups.ts update.ts metrics.ts
  src/types/      task.ts schedule.ts log.ts testbench.ts settings.ts system.ts
  src/stores/     tasks.ts logs.ts settings.ts toast.ts
  src/composables/ usePolling.ts useAsyncAction.ts useDirtyForm.ts useDateTime.ts
  src/components/
    common/       AppHeader.vue StatusStrip.vue ConditionBadge.vue ConditionPopover.vue
                  WeekdayPicker.vue TimeWindowPicker.vue StickyActionBar.vue ConfirmDialog.vue
    task/         TaskList.vue TaskCard.vue TaskActions.vue
    task-form/    TaskForm.vue sections/RequestSection.vue sections/ScheduleSection.vue
                  sections/SuccessSection.vue sections/MoreSettings.vue
    logs/         LogsPanel.vue LogListItem.vue LogDetailDrawer.vue
    test/         TestBenchDialog.vue TestStepTimeline.vue TestHistoryList.vue
    settings/     SettingsDialog.vue BackupSection.vue UpdateSection.vue DangerSection.vue
    stats/        StatsDialog.vue
    dialogs/      PauseDialog.vue DeleteTaskDialog.vue CleanupLogsDialog.vue
  src/utils/      format.ts schedule.ts condition.ts errors.ts
  tests/          unit/ condition.spec.ts schedule.spec.ts  component/ TaskForm.spec.ts
```

关键组件职责：

- `App.vue`：顶栏、统计/设置入口、全局健康状态、升级提示、Toast 容器。
- `TaskList / TaskCard`：卡片状态、调度描述、运行中徽标、主操作（立即执行）与「更多」菜单（停止/启用、暂停/恢复、编辑、删除）。
- `ConditionBadge`：仅 `precheck_enabled` 时显示；外层 `a-popover`，trigger 支持 hover / focus / click。内容逐项列出已配置条件：星期、时段、仅接通电源、本机 IP 模式、条件检查 curl、期望状态码/表达式；末尾固定说明「条件不满足会跳过并记录原因；页面『立即执行』不受条件限制」。无配置项时显示「未限制」。
- `TaskForm`：拥有表单模型、校验、脏检查、提交；子 Section 只负责渲染和 `v-model`，不发请求。
- `LogsPanel`：轮询、游标加载更多、去重合并、详情抽屉；保留手动/开机触发标记。
- `TestBenchDialog`：五步时间线（解析 → 本地条件 → 条件检查 → 主请求 → 成功/通知）、历史、保存为任务。
- `SettingsDialog`：分区保存（常规、备份、更新、退出），不再是单个巨型保存按钮。
- `PauseDialog / DeleteTaskDialog / CleanupLogsDialog`：危险操作二次确认；保留现有语义（删除需确认任务名、清理全部需输入 `DELETE_ALL`）。

## 任务表单 UX 规范

单页自上而下三段，底部固定操作栏：

1. **请求**
   - 任务名称：必填，1–200 字。
   - 请求方式：`粘贴 curl`（默认）/ `手动填写`，用 `a-segmented` 切换。
   - curl 模式：curl 文本框必填，右侧提供「先试跑」。
   - 手动模式：URL 必填（http/https）、方法必选；Headers / Body 收在「可选」折叠里。
2. **执行时间**
   - 调度方式：`每天一次`（默认）/ `每隔一段时间`。
   - 每天：`时段内随机`（默认）或 `固定时间`；时段起止必填且不能相同；固定时间可加 0–60 分钟抖动；下方实时预览「每天 09:00–18:00 随机一次，约 14:32 执行」。
   - 间隔：数值 ≥1，单位秒/分钟；抖动 ≤ 间隔；首次执行时间可选。
   - 开机后自动执行一次：开关，默认关闭；帮助文案说明「Jitter 启动 15 秒后执行，仍检查条件，恢复备份不触发」。
3. **成功条件**（常显）
   - 默认「任意 2xx 视为成功」，折叠「自定义」后可填状态码（100–599）、响应体包含、表达式。
4. **更多设置**（默认折叠，已有配置时自动展开并显示摘要）
   - 通知：开关 + 通知 curl（开启时必填）+ 试跑。
   - 执行条件：总开关 + 四组可独立填写的条件（时间/电源/IP/前置 curl），并提示至少填一项；前置状态码或表达式必须搭配前置 curl。

固定操作栏：

- 创建模式：左侧「重置」，右侧主按钮「创建任务」。
- 编辑模式：左侧「取消编辑」，右侧「保存修改」。
- 有未保存修改时左侧显示提示；提交中全表禁用、按钮 loading；后端错误用可关闭 Alert 展示且不丢输入。
- 校验在 blur/change 与提交时执行，错误贴字段下方；提交失败自动滚动到首个错误。
- 取消、ESC、点遮罩：有脏数据先确认；创建成功后留在列表并选中新任务。

其它表单：

- 试跑：主请求、条件、判定分组展示；运行按钮与历史分离，避免「跑完不知道结果在哪」。
- 设置：常规（保留天数 0–3650、默认跳过 TLS、防休眠、开机自启）、备份（列表/创建/下载/上传/恢复/删除）、更新（检查/进度/应用）、退出；每区独立保存并显示结果。
- 暂停：1 小时 / 4 小时 / 1 天 / 自定义起止；展示「暂停到 …」。
- 删除：展示任务名与影响，危险按钮红色，取消始终可用。
- 清理：时间范围/全部 + 预览条数，执行前确认。

## 构建与嵌入

- `web/vite.config.ts`：`base: '/'`、`outDir: 'dist'`、`assetsDir: 'assets'`、开发代理 `/api` 到 Rust。
- `web/package.json` 脚本：`dev`、`build`、`typecheck`（`vue-tsc --noEmit`）、`test`（Vitest + @vue/test-utils）。
- Rust：`jitter-app` 增加 `include_dir`、`mime_guess`；嵌入 `web/dist`。
  - `GET /` 返回 `index.html`，`Cache-Control: no-cache`。
  - `GET /assets/*path` 返回带哈希资源，`Cache-Control: public, max-age=31536000, immutable`。
  - 未知路径保持 404，不影响 `/api/*`。
  - `build.rs` 只检查 `web/dist/index.html` 是否存在，缺失时给出「先运行 bun run build:web」的明确错误，不在构建脚本里调用包管理器。
- Bun：`src/index.ts` 去掉 HTML import，改为 `Bun.file` 读取 `web/dist`；缺失时返回 503 并提示构建，不阻塞 Rust 主路径。
- CI：
  - 新增 `frontend` job：`bun install`（工作目录 `web`）、typecheck、Vitest、build，上传 `web-dist` artifact。
  - Rust CI 与 release 矩阵在 cargo 构建前下载 artifact 到 `web/dist`，否则嵌入失败。
  - 根目录脚本：`build:web`、`dev:web`、`typecheck:web`，方便本地使用。
- 本地开发：`bun --cwd web run dev` + `cargo run -p jitter-app`（/api 代理）；验证嵌入式构建时先 `bun run build:web`。

## 实施顺序

1. **脚手架与静态链路**：`web/` 初始化、主题、路由静态资源、`include_dir`、Bun 静态服务、CI artifact。检查：Vite build 成功，Rust 启动后 `/` 与 `/assets/*` 200，旧的 `/api/*` 不受影响。
2. **类型与 API 层**：按 `api.rs` 精确建模任务、日志、设置、指标、测试台、备份、更新；统一 `request<T>()`（15s 默认、执行 60s、测试 100s、备份 120s，解析 `{error}`）。检查：类型编译 + API 契约单测。
3. **只读界面**：App 骨架、任务列表/卡片、条件 Popover、日志列表与详情。检查：与旧版字段、文案、状态逐项对比。
4. **任务表单**：三段式 + 固定操作栏 + 校验/脏检查 + 调度预览；curl/结构化双模式；编辑回填。检查：抓包比对旧版 payload，所有必填/取消/保存路径可走通。
5. **任务动作**：立即执行、停止/启用、暂停/恢复、删除、重排、日志清理。检查：每个动作后列表、徽标、日志刷新正确。
6. **测试台与设置**：五步时间线、历史、保存为任务；常规/备份/更新/退出/统计。检查：恢复备份、上传下载、更新检查、退出流程。
7. **收尾**：删除旧 `index.html`/`app.js`、`/app.js` 路由与 HTML import；更新 README/HANDOVER、CI/release、版本号。
8. **回归**：`cargo test -p jitter-core`、`bun test`、web typecheck/build/Vitest、真实数据库副本迁移启动、浏览器全流程。

## 验证清单

- 表单：空提交逐项报错并聚焦；只填必填可创建；编辑回填完整；取消/ESC 有脏确认；保存失败不丢输入；重复提交被阻止。
- 条件气泡：hover、键盘 focus、点击都能打开；列出所有已配置条件；未启用时不显示。
- 任务动作：立即执行（绕过条件）、停止/启用、暂停/恢复、删除、清理日志全部生效；执行中状态与日志轮询一致。
- 测试台：五步顺序与判定正确；历史可回看；保存为任务后字段一致。
- 设置：保留天数、TLS、防休眠、自启、备份创建/下载/上传/恢复/删除、更新检查与进度、退出。
- 兼容性：复制现有 `data/app.db` 启动，旧任务/日志/设置完整；创建与编辑字段无丢失；`run_on_startup`、`precheck_*` 正常。
- 静态资源：首页不缓存、assets 长缓存；刷新深链接不 404；无控制台错误。
- CI/Release：三平台构建通过，安装包可启动并打开新 UI。

## 风险与规避

- **字段漂移**：以 `parse_task_input` / `task_view` 为准写 TS 类型和契约测试；任务载荷保持 snake_case。
- **轮询与日志去重**：游标用 `<executed_at>:<id>` 字符串，按 id 合并；页面隐藏暂停轮询。
- **长请求**：执行 60s、测试 100s、备份 120s 分级超时；超时后刷新任务与日志，提示可能仍在执行。
- **时间语义**：全部本地时区；跨午夜窗口保留 `start > end`；毫秒时间戳统一格式化。
- **弹窗串数据**：关闭即销毁或显式 reset，试跑/编辑切换时重建表单快照。
- **构建链路**：dist 不提交，CI 必须先构建前端；`build.rs` 只做存在性检查，避免构建脚本执行包管理器。
- **antdv-next API 差异**：实现前按官网核对 Form/Popover/TimePicker/Modal 的 props 与事件；优先使用受控组件。
- **Bun 版**：只保证静态服务与 API 可用，不追新字段；出问题不影响 Rust 发布。

## 不在本次范围

- 后端接口、数据库结构和调度语义的重构。
- 深色主题、国际化、Vue Router 多页路由。
- Bun 版功能追平与性能优化。

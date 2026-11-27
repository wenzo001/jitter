/**
 * TaskForm 可靠性回归：
 * - 保存失败必须显示在对话框内（不能只写全局状态行）；
 * - 复制任务提交 payload 默认 status='stopped'，并在对话框内提示「复制后默认停用」；
 * - 条件校验错误必须有可聚焦锚点（data-error-key）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Task } from '@/types/task'
import { i18n } from '@/i18n'
import TaskForm from '@/components/task/TaskForm.vue'

const createTask = vi.fn()
const updateTask = vi.fn()
const listTasks = vi.fn()
const previewSchedule = vi.fn()

vi.mock('@/api/tasks', () => ({
  createTask: (...args: unknown[]) => createTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  previewSchedule: (...args: unknown[]) => previewSchedule(...args),
  listTasks: (...args: unknown[]) => listTasks(...args),
  reorderTasks: vi.fn(),
}))

vi.mock('@/api/testbench', () => ({
  runTestBench: vi.fn(),
  listTestRuns: vi.fn().mockResolvedValue({ runs: [] }),
  getTestRun: vi.fn(),
}))

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: '每日签到',
    curl_command: "curl -X POST 'https://example.com/api'",
    request_url: 'https://example.com/api',
    request_method: 'POST',
    request_headers: null,
    request_body: null,
    request_options: null,
    window_start: '09:00',
    window_end: '10:00',
    daily_jitter_minutes: 0,
    schedule_kind: 'daily',
    interval_seconds: null,
    interval_jitter_seconds: 0,
    interval_start_at: null,
    status: 'active',
    next_run_at: null,
    paused_from: null,
    paused_until: null,
    created_at: 0,
    updated_at: 0,
    sort_order: 0,
    notify_enabled: 0,
    notify_curl_command: null,
    notify_url: null,
    notify_method: null,
    notify_headers: null,
    notify_body: null,
    notify_options: null,
    precheck_enabled: 0,
    precheck_curl_command: null,
    precheck_url: null,
    precheck_method: null,
    precheck_headers: null,
    precheck_body: null,
    precheck_options: null,
    precheck_expect_status: null,
    precheck_expr: null,
    precheck_weekdays: null,
    precheck_time_start: null,
    precheck_time_end: null,
    precheck_require_ac: 0,
    precheck_require_network: 0,
    log_retention_days: null,
    precheck_ip_pattern: null,
    precheck_day_type: null,
    run_on_startup: 0,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
    schedule_description: '每天 09:00–10:00',
    running: false,
    running_since: null,
    schedule_error: null,
    last_run: null,
    ...overrides,
  } as Task
}

function mountForm() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(TaskForm, { global: { plugins: [i18n, pinia] } })
}

describe('TaskForm 保存失败反馈', () => {
  beforeEach(() => {
    createTask.mockReset()
    updateTask.mockReset()
    listTasks.mockReset()
    listTasks.mockResolvedValue({ tasks: [] })
  })

  it('保存失败时错误文案显示在对话框内，而不是只写全局状态', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.model.name = '任务A'
    vm.model.curl = "curl 'https://example.com/x'"
    createTask.mockRejectedValue(new Error('任务名称重复'))

    await vm.submit()
    await flushPromises()

    expect(wrapper.text()).toContain('任务名称重复')
    wrapper.unmount()
  })

  it('重新提交前先清掉上一条对话框内错误', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.model.name = '任务A'
    vm.model.curl = "curl 'https://example.com/x'"
    createTask.mockRejectedValueOnce(new Error('任务名称重复'))
    await vm.submit()
    await flushPromises()
    expect(wrapper.text()).toContain('任务名称重复')

    createTask.mockResolvedValueOnce({ task: taskFixture({ status: 'stopped' }) })
    await vm.submit()
    await flushPromises()
    expect(wrapper.text()).not.toContain('任务名称重复')
    wrapper.unmount()
  })
})

describe('TaskForm 复制任务', () => {
  beforeEach(() => {
    createTask.mockReset()
    updateTask.mockReset()
    listTasks.mockReset()
    listTasks.mockResolvedValue({ tasks: [] })
  })

  it('复制后对话框内提示「复制后默认停用」', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.loadDraft(taskFixture())
    await flushPromises()
    expect(wrapper.text()).toContain('复制后默认停用')
    wrapper.unmount()
  })

  it('复制任务创建时 payload 默认 status=stopped', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.loadDraft(taskFixture())
    await flushPromises()
    createTask.mockResolvedValue({ task: taskFixture({ id: 't2', status: 'stopped' }) })

    await vm.submit()
    await flushPromises()

    expect(createTask).toHaveBeenCalledTimes(1)
    const payload = createTask.mock.calls[0][0]
    expect(payload.status).toBe('stopped')
    wrapper.unmount()
  })

  it('普通新建不携带 status 字段', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.startCreate()
    vm.model.name = '新任务'
    vm.model.curl = "curl 'https://example.com/x'"
    createTask.mockResolvedValue({ task: taskFixture({ id: 't3' }) })

    await vm.submit()
    await flushPromises()

    const payload = createTask.mock.calls[0][0]
    expect('status' in payload).toBe(false)
    wrapper.unmount()
  })
})

describe('TaskForm 计划预览竞态', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    previewSchedule.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('输入变为无效后，迟到的旧预览不能回填', async () => {
    let resolve!: (value: unknown) => void
    previewSchedule.mockReturnValue(new Promise((r) => (resolve = r)))
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    await nextTick()
    vi.clearAllTimers()
    previewSchedule.mockClear()
    vm.model.scheduleKind = 'daily'
    vm.model.dailyMode = 'exact'
    vm.model.exactTime = '09:00'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    expect(previewSchedule).toHaveBeenCalled()

    vm.model.exactTime = ''
    await nextTick()
    resolve({ kind: 'daily', next: [], window: null, jitter_minutes: 0, description: '旧预览' })
    await flushPromises()

    expect(vm.preview).toBeNull()
    wrapper.unmount()
  })
})

describe('TaskForm 条件校验错误锚点', () => {
  beforeEach(() => {
    createTask.mockReset()
    listTasks.mockReset()
    listTasks.mockResolvedValue({ tasks: [] })
  })

  it('启用执行条件但未配置时，condAny 错误有 data-error-key 锚点并显示在对话框内', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.precheckOn = true
    await flushPromises()

    await vm.submit()
    await flushPromises()

    expect(wrapper.text()).toContain('至少配置')
    expect(wrapper.find('[data-error-key="condAny"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('条件状态码越界且未填 curl 时，condCurl / condStatus 锚点可达', async () => {
    const wrapper = mountForm()
    const vm = wrapper.vm as any
    vm.precheckOn = true
    await flushPromises()
    vm.model.conditions.expectStatus = '999'

    await vm.submit()
    await flushPromises()

    expect(wrapper.find('[data-error-key="condStatus"]').exists()).toBe(true)
    expect(wrapper.find('[data-error-key="condCurl"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

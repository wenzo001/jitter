/**
 * LogsPanel 查询失败回归：
 * - 失败时显示错误 + 「重试」入口，而不是「没有记录」；
 * - 已有日志时失败不清空列表，只显示错误提示；
 * - 重试成功后错误提示消失。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LogSummary, Task } from '@/types/task'
import { i18n } from '@/i18n'
import { useTasksStore } from '@/stores/tasks'
import LogsPanel from '@/components/logs/LogsPanel.vue'

const { listTasks, listLogs, getLogDetail } = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listLogs: vi.fn(),
  getLogDetail: vi.fn().mockResolvedValue({ log: null }),
}))
vi.mock('@/api/tasks', () => ({
  listTasks: (...args: unknown[]) => listTasks(...args),
  reorderTasks: vi.fn(),
  listLogs: (...args: unknown[]) => listLogs(...args),
  getLogDetail: (...args: unknown[]) => getLogDetail(...args),
}))

function taskFixture(): Task {
  return {
    id: 't1',
    name: '每日签到',
    status: 'active',
    schedule_kind: 'daily',
    window_start: '09:00',
    window_end: '10:00',
    interval_seconds: null,
    interval_jitter_seconds: 0,
    interval_start_at: null,
    daily_jitter_minutes: 0,
    next_run_at: null,
    running: false,
    running_since: null,
    last_run: null,
    precheck_enabled: 0,
    notify_enabled: 0,
    schedule_error: null,
    paused_from: null,
    paused_until: null,
  } as unknown as Task
}

function logOf(id: number): LogSummary {
  return {
    id,
    task_id: 't1',
    executed_at: 1_700_000_000_000 + id,
    request_url: 'https://example.com/ping',
    request_method: 'GET',
    response_status: 200,
    duration_ms: 10,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: 1,
    run_source: 'scheduled',
  }
}

async function mountPanel() {
  const pinia = createPinia()
  setActivePinia(pinia)
  await useTasksStore().load()
  const wrapper = mount(LogsPanel, { global: { plugins: [i18n, pinia] } })
  await flushPromises()
  return wrapper
}

describe('LogsPanel 查询失败', () => {
  beforeEach(() => {
    listTasks.mockReset()
    listLogs.mockReset()
    listTasks.mockResolvedValue({ tasks: [taskFixture()] })
  })

  it('无缓存时失败：显示错误 + 重试，不再显示「还没有执行记录」', async () => {
    listLogs.mockRejectedValue(new Error('连不上后台服务'))
    const wrapper = await mountPanel()

    expect(wrapper.text()).toContain('连不上后台服务')
    expect(wrapper.text().replace(/\s+/g, '')).toContain('重试')
    expect(wrapper.text()).not.toContain('这个任务还没有执行记录')
    wrapper.unmount()
  })

  it('已有日志时失败：保留旧日志并显示错误', async () => {
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: false,
      retention_days: 30,
    })
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('https://example.com/ping')

    listLogs.mockRejectedValueOnce(new Error('查询失败'))
    const tasks = useTasksStore()
    // 触发一次重新加载（refresh 按钮路径内部调用 load）。
    const refreshBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('刷新'))
    expect(refreshBtn).toBeTruthy()
    // tasks.load 也要成功，让 refresh 走到 logs.load。
    listTasks.mockResolvedValue({ tasks: [taskFixture()] })
    await refreshBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('查询失败')
    expect(wrapper.text()).toContain('https://example.com/ping')
    wrapper.unmount()
  })

  it('点重试成功后错误提示消失', async () => {
    listLogs.mockRejectedValueOnce(new Error('连不上后台服务'))
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('连不上后台服务')

    listLogs.mockResolvedValueOnce({
      logs: [logOf(9)],
      has_more: false,
      retention_days: 30,
    })
    const retryBtn = wrapper
      .findAll('button')
      .find((b) => b.text().replace(/\s+/g, '').includes('重试'))
    expect(retryBtn).toBeTruthy()
    await retryBtn!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('连不上后台服务')
    expect(wrapper.text()).toContain('https://example.com/ping')
    wrapper.unmount()
  })
})

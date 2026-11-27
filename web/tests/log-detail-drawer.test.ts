/**
 * LogDetailDrawer 竞态回归：A→B 切换后，迟到的 A 响应不能覆盖 B。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LogDetail } from '@/types/task'
import { i18n } from '@/i18n'
import LogDetailDrawer from '@/components/logs/LogDetailDrawer.vue'

const { getLogDetail, listLogs } = vi.hoisted(() => ({
  getLogDetail: vi.fn(),
  listLogs: vi.fn().mockResolvedValue({ logs: [], has_more: false, retention_days: 30 }),
}))
vi.mock('@/api/tasks', () => ({
  getLogDetail: (...args: unknown[]) => getLogDetail(...args),
  listLogs: (...args: unknown[]) => listLogs(...args),
}))

function detailOf(id: number, url: string): LogDetail {
  return {
    id,
    task_id: 't1',
    executed_at: 1_700_000_000_000,
    request_url: url,
    request_method: 'GET',
    response_status: 200,
    duration_ms: 5,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: 1,
    run_source: 'scheduled',
    request_headers: null,
    request_body: null,
    response_headers: null,
    response_body: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('LogDetailDrawer 请求代际保护', () => {
  beforeEach(() => {
    getLogDetail.mockReset()
    setActivePinia(createPinia())
  })

  it('通知 HTTP 500 即使没有传输层 error 也显示失败', async () => {
    const notify = {
      ...detailOf(2, 'https://example.com/notify'),
      kind: 'notify',
      parent_log_id: 1,
      response_status: 500,
      error: null,
    }
    getLogDetail.mockResolvedValue({
      log: { ...detailOf(1, 'https://example.com/task'), notify },
    })

    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(LogDetailDrawer, {
      props: { open: true, logId: 1 },
      global: {
        plugins: [i18n, pinia],
        stubs: { 'a-drawer': { template: '<div><slot /></div>' } },
      },
    })
    await flushPromises()

    expect(wrapper.find('.notify-state').text()).toContain('失败')
    expect(wrapper.find('.notify-state').text()).not.toContain('已发送')
    wrapper.unmount()
  })

  it('关闭后重开同一条日志：共享在途请求并展示结果', async () => {
    const pending = deferred<{ log: LogDetail }>()
    getLogDetail.mockReturnValue(pending.promise)
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(LogDetailDrawer, {
      props: { open: true, logId: 1 },
      global: { plugins: [i18n, pinia] },
    })
    await flushPromises()
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()

    expect(getLogDetail).toHaveBeenCalledTimes(1)
    pending.resolve({ log: detailOf(1, 'https://example.com/reopened') })
    await flushPromises()

    const vm = wrapper.vm as any
    expect(vm.detail?.id).toBe(1)
    expect(vm.error).toBe('')
    wrapper.unmount()
  })

  it('A→B 后迟到的 A 响应不得覆盖 B 的详情', async () => {
    const a = deferred<{ log: LogDetail }>()
    const b = deferred<{ log: LogDetail }>()
    getLogDetail.mockImplementation((id: number) => (id === 1 ? a.promise : b.promise))

    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(LogDetailDrawer, {
      props: { open: true, logId: 1 },
      global: { plugins: [i18n, pinia] },
    })
    await flushPromises()
    expect(getLogDetail).toHaveBeenCalledWith(1)

    // 用户切去看记录 2。
    await wrapper.setProps({ logId: 2 })
    await flushPromises()
    expect(getLogDetail).toHaveBeenCalledWith(2)

    // B 先回来。
    b.resolve({ log: detailOf(2, 'https://example.com/B') })
    await flushPromises()
    // 迟到的 A 后回来——不能覆盖 B。
    a.resolve({ log: detailOf(1, 'https://example.com/A') })
    await flushPromises()

    const vm = wrapper.vm as any
    expect(vm.detail?.id).toBe(2)
    expect(vm.detail?.request_url).toBe('https://example.com/B')
    wrapper.unmount()
  })
})

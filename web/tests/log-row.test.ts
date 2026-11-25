import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { LogSummary } from '@/types/task'
import { i18n } from '@/i18n'
import LogRow from '@/components/logs/LogRow.vue'

function logOf(overrides: Partial<LogSummary> = {}): LogSummary {
  return {
    id: 1,
    task_id: 't1',
    executed_at: 1_700_000_000_000,
    request_url: 'http://1.1.1.3/ac_portal/login.php',
    request_method: 'POST',
    response_status: null,
    duration_ms: 0,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: null,
    run_source: 'scheduled',
    ...overrides,
  } as LogSummary
}

describe('components/logs/LogRow', () => {
  it('普通记录可以点开详情', async () => {
    const wrapper = mount(LogRow, {
      props: { log: logOf({ response_status: 200, matched: 1 }) },
      global: { plugins: [i18n] },
    })
    await wrapper.find('.log-item').trigger('click')
    expect(wrapper.emitted('select')).toBeTruthy()
    expect(wrapper.text()).toContain('详情')
    wrapper.unmount()
  })

  it('跳过记录不可点开详情', async () => {
    const wrapper = mount(LogRow, {
      props: { log: logOf({ kind: 'skipped', error: '不在执行时段内' }) },
      global: { plugins: [i18n] },
    })
    await wrapper.find('.log-item').trigger('click')
    expect(wrapper.emitted('select')).toBeFalsy()
    expect(wrapper.text()).toContain('无详情')
    expect(wrapper.find('.log-item').classes()).toContain('is-disabled')
    wrapper.unmount()
  })

  it('错过的记录同样不可点开详情', async () => {
    const wrapper = mount(LogRow, {
      props: { log: logOf({ kind: 'missed' }) },
      global: { plugins: [i18n] },
    })
    await wrapper.find('.log-item').trigger('click')
    expect(wrapper.emitted('select')).toBeFalsy()
    wrapper.unmount()
  })

  it('合并标记仍然可以展开（不被禁用挡住）', async () => {
    const wrapper = mount(LogRow, {
      props: { log: logOf({ kind: 'skipped' }), mergeCount: 6 },
      global: { plugins: [i18n] },
    })
    await wrapper.find('.merge-tag').trigger('click')
    expect(wrapper.emitted('toggle')).toBeTruthy()
    expect(wrapper.emitted('select')).toBeFalsy()
    wrapper.unmount()
  })
})

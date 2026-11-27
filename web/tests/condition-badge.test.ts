/**
 * 任务卡状态徽标：未开启执行条件时不应展示「执行条件」入口（含混信息）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Task } from '@/types/task'
import { i18n } from '@/i18n'
import ConditionBadge from '@/components/task/ConditionBadge.vue'

vi.mock('@/api/tasks', () => ({
  listTasks: vi.fn(),
  reorderTasks: vi.fn(),
  listLogs: vi.fn(),
  getLogDetail: vi.fn(),
}))

function taskFixture(precheck: 0 | 1): Task {
  return {
    id: 't1',
    name: 'x',
    status: 'active',
    schedule_kind: 'daily',
    window_start: '09:00',
    window_end: '10:00',
    next_run_at: null,
    running: false,
    precheck_enabled: precheck,
    notify_enabled: 0,
    schedule_error: null,
  } as unknown as Task
}

function mountBadge(precheck: 0 | 1) {
  return mount(ConditionBadge, {
    props: { task: taskFixture(precheck), now: Date.now() },
    global: { plugins: [i18n, createPinia()] },
  })
}

describe('ConditionBadge 执行条件入口', () => {
  it('未开启执行条件时不显示「执行条件」徽标', () => {
    const wrapper = mountBadge(0)
    expect(wrapper.text()).not.toContain('执行条件')
    expect(wrapper.text()).toContain('调度中')
    wrapper.unmount()
  })

  it('开启执行条件时显示「执行条件」徽标', () => {
    const wrapper = mountBadge(1)
    expect(wrapper.text()).toContain('执行条件')
    wrapper.unmount()
  })
})

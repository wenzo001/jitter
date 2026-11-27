/**
 * 可靠性文案回归：
 * - 停止任务的确认文案必须说明「停止只阻止后续计划，不会中断正在执行的请求」；
 * - 删除可能运行中任务的对话框必须提示「删除可能中断正在执行的请求」；
 * - 复制任务的提示与文案。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import zhCN from '@/locales/zh-CN'
import enUS from '@/locales/en-US'
import type { Task } from '@/types/task'
import { i18n } from '@/i18n'
import DeleteTaskDialog from '@/components/dialogs/DeleteTaskDialog.vue'

const { deleteTask } = vi.hoisted(() => ({ deleteTask: vi.fn() }))
vi.mock('@/api/tasks', () => ({
  deleteTask: (...args: unknown[]) => deleteTask(...args),
}))

describe('停止任务文案', () => {
  it('中文停止文案明确「不会中断正在执行的请求」', () => {
    expect(zhCN.task.stopContent).toContain('不会中断正在执行的请求')
    expect(zhCN.task.stopContent).toContain('{name}')
  })

  it('英文停止文案同样说明不会中断进行中的请求', () => {
    expect(enUS.task.stopContent.toLowerCase()).toContain('does not interrupt')
  })
})

describe('删除任务文案', () => {
  it('存在运行中提醒文案 key（中英文）', () => {
    expect(zhCN.deleteTask.runningWarning).toContain('删除可能中断正在执行的请求')
    expect(enUS.deleteTask.runningWarning).toContain('interrupt')
  })
})

describe('DeleteTaskDialog 运行中提醒', () => {
  afterEach(() => {
    // a-modal 挂载在 body 上，卸载后清理测试注入的 DOM。
    document.body.replaceChildren()
  })

  function taskOf(running: boolean): Task {
    return {
      id: 't1',
      name: '每日签到',
      status: 'active',
      running,
    } as Task
  }

  it('任务可能运行中时显示「删除可能中断正在执行的请求」', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(DeleteTaskDialog, {
      props: { open: true, task: taskOf(true) },
      global: { plugins: [i18n, pinia] },
    })
    const body = () => document.body.textContent ?? ''
    expect(body()).toContain('删除可能中断正在执行的请求')
    wrapper.unmount()
  })

  it('任务未运行时不显示运行中提醒', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(DeleteTaskDialog, {
      props: { open: true, task: taskOf(false) },
      global: { plugins: [i18n, pinia] },
    })
    const body = () => document.body.textContent ?? ''
    expect(body()).not.toContain('删除可能中断正在执行的请求')
    wrapper.unmount()
  })
})

describe('复制任务提示', () => {
  it('复制后默认停用的提示文案存在（taskForm.copyHint）', () => {
    expect(zhCN.taskForm.copyHint).toContain('复制后默认停用')
    expect(enUS.taskForm.copyHint.toLowerCase()).toContain('starts stopped')
  })

  it('复制完成的顶栏状态也说明默认停用', () => {
    expect(zhCN.task.copiedStatus).toContain('默认停用')
    expect(enUS.task.copiedStatus.toLowerCase()).toContain('starts stopped')
  })
})

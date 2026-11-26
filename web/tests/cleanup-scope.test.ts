import { describe, expect, it } from 'vitest'
import {
  cleanupRequestBody,
  defaultCleanupScope,
  effectiveCleanupTaskId,
} from '@/utils/cleanup-scope'

describe('utils/cleanup-scope', () => {
  it('有任务时默认只清这个任务，没有就清全部', () => {
    expect(defaultCleanupScope('t1')).toBe('task')
    expect(defaultCleanupScope(null)).toBe('all')
    expect(defaultCleanupScope(undefined)).toBe('all')
    expect(defaultCleanupScope('')).toBe('all')
  })

  it('选「全部任务」时不带 task_id', () => {
    expect(effectiveCleanupTaskId('all', 't1')).toBeNull()
  })

  it('选「当前任务」时带上 task_id', () => {
    expect(effectiveCleanupTaskId('task', 't1')).toBe('t1')
    expect(effectiveCleanupTaskId('task', null)).toBeNull()
  })

  it('按档位清理的任务级请求体带上 task_id', () => {
    expect(cleanupRequestBody('task', 't1', 30)).toEqual({
      days: 30,
      confirm: true,
      task_id: 't1',
    })
  })

  it('清空全部时是 all + 确认关键字', () => {
    expect(cleanupRequestBody('task', 't1', 'all')).toEqual({
      all: true,
      confirm: 'DELETE_ALL',
      task_id: 't1',
    })
    expect(cleanupRequestBody('all', 't1', 'all')).toEqual({
      all: true,
      confirm: 'DELETE_ALL',
    })
  })

  it('cutoff 只在是整数时带上', () => {
    expect(cleanupRequestBody('task', 't1', 10, 1_700_000_000_000)).toEqual({
      days: 10,
      confirm: true,
      task_id: 't1',
      cutoff: 1_700_000_000_000,
    })
    expect(cleanupRequestBody('task', 't1', 10, null)).not.toHaveProperty('cutoff')
  })
})

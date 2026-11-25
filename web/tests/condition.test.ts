import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import { conditionRows, conditionSummary } from '@/utils/condition'
import { conditionFromTask, emptyCondition } from '@/types/form'
import { describeHostEnvironment, describeHostNetwork } from '@/utils/environment'

function taskOf(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: '测试',
    status: 'active',
    schedule_kind: 'daily',
    window_start: '09:00',
    window_end: '18:00',
    daily_jitter_minutes: 0,
    interval_seconds: null,
    interval_start_at: null,
    interval_jitter_seconds: 0,
    schedule_description: '',
    precheck_enabled: 1,
    precheck_weekdays: null,
    precheck_time_start: null,
    precheck_time_end: null,
    precheck_require_ac: 0,
    precheck_require_network: 0,
    precheck_ip_pattern: null,
    precheck_day_type: null,
    precheck_curl_command: null,
    precheck_url: null,
    precheck_expr: null,
    precheck_expect_status: null,
    run_on_startup: 0,
    ...overrides,
  } as Task
}

describe('执行条件：已连接网络', () => {
  it('没有该条件时不出现「网络」这一行', () => {
    const rows = conditionRows(taskOf({ precheck_require_ac: 1 }))
    expect(rows.some((row) => row.key === 'network')).toBe(false)
  })

  it('开启后条件明细里出现网络这一行', () => {
    const rows = conditionRows(taskOf({ precheck_require_network: 1 }))
    const network = rows.find((row) => row.key === 'network')
    expect(network).toBeDefined()
    expect(network?.label).toBe('网络')
    expect(network?.value).toContain('网络')
  })

  it('任务卡摘要列出网络条件', () => {
    const summary = conditionSummary(taskOf({ precheck_require_network: 1 }))
    expect(summary).toContain('网络')
  })

  it('表单模型能读出该条件', () => {
    const model = conditionFromTask(taskOf({ precheck_require_network: 1 }))
    expect(model.requireNetwork).toBe(true)
    expect(emptyCondition().requireNetwork).toBe(false)
  })
})

describe('utils/environment', () => {
  it('展示当前连接的网络类型与名称', () => {
    const text = describeHostEnvironment({
      onAcPower: true,
      localIps: ['10.1.2.3'],
      networks: [{ name: 'WLAN', kind: 'wifi' }],
      preventSleepOnAc: false,
    })
    expect(text).toContain('WiFi')
    expect(text).toContain('WLAN')
  })

  it('没有网络时明确提示未连接', () => {
    const text = describeHostEnvironment({
      onAcPower: true,
      localIps: ['10.1.2.3'],
      networks: [],
      preventSleepOnAc: false,
    })
    expect(text).toContain('未连接网络')
  })

  it('网络提示只讲网络', () => {
    const env = {
      onAcPower: true,
      localIps: ['10.1.2.3'],
      networks: [{ name: 'WLAN', kind: 'wifi' as const }],
      preventSleepOnAc: false,
    }
    const text = describeHostNetwork(env)
    expect(text).toBe('WiFi（WLAN）')
    expect(text).not.toContain('10.1.2.3')
    expect(describeHostNetwork({ ...env, networks: [] })).toBe('未连接网络')
    expect(describeHostNetwork(null)).toBe('')
    // 网卡名跟类型一样时不重复括号。
    expect(
      describeHostNetwork({
        ...env,
        networks: [{ name: '以太网', kind: 'ethernet' }],
      }),
    ).toBe('以太网')
  })
})

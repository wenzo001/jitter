import type { Task } from './task'
import { headersToText, precheckCurlOf } from '@/utils/curl'
import { toDateTimeLocal } from '@/utils/format'

export interface ConditionModel {
  weekdays: number[]
  timeStart: string
  timeEnd: string
  requireAc: boolean
  /** 必须已连接网络（WiFi 或网线）。 */
  requireNetwork: boolean
  ipPattern: string
  /** 工作日 / 休息日条件：'' 表示不限制。 */
  dayType: '' | 'workday' | 'offday'
  curl: string
  expectStatus: string
  expr: string
}

export interface TaskFormModel {
  name: string
  mode: 'curl' | 'structured'
  curl: string
  url: string
  method: string
  headers: string
  body: string
  scheduleKind: 'daily' | 'interval'
  dailyMode: 'range' | 'exact' | 'jitter'
  windowStart: string
  windowEnd: string
  exactTime: string
  jitterMinutes: number
  intervalValue: number
  intervalUnit: number
  intervalStart: string
  intervalJitter: number
  runOnStartup: boolean
  notifyEnabled: boolean
  notifyCurl: string
  expectStatus: string
  expectBody: string
  expectExpr: string
  conditions: ConditionModel
}

/** 表单通用错误表：key 与字段绑定，提交时定位第一个错误。 */
export type FormErrors = Record<string, string>

export function emptyCondition(): ConditionModel {
  return {
    weekdays: [],
    timeStart: '',
    timeEnd: '',
    requireAc: false,
    requireNetwork: false,
    ipPattern: '',
    dayType: '',
    curl: '',
    expectStatus: '',
    expr: '',
  }
}

export function conditionFromTask(task: Task): ConditionModel {
  return {
    weekdays: task.precheck_weekdays
      ? task.precheck_weekdays
          .split(',')
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value))
      : [],
    timeStart: task.precheck_time_start ?? '',
    timeEnd: task.precheck_time_end ?? '',
    requireAc: task.precheck_require_ac === 1,
    requireNetwork: task.precheck_require_network === 1,
    ipPattern: task.precheck_ip_pattern ?? '',
    dayType: task.precheck_day_type === 'workday' || task.precheck_day_type === 'offday' ? task.precheck_day_type : '',
    curl: precheckCurlOf(task),
    expectStatus:
      task.precheck_expect_status === null || task.precheck_expect_status === undefined
        ? ''
        : String(task.precheck_expect_status),
    expr: task.precheck_expr ?? '',
  }
}

/**
 * 复制任务时的默认名字：原名 + 副本后缀。
 *
 * 任务名上限 200 字（后端校验），超长时截断**原名**，后缀一定保留。
 */
export function copiedTaskName(name: string, suffix: string, max = 200): string {
  const chars = [...name.trim()]
  const room = Math.max(0, max - [...suffix].length)
  return `${chars.slice(0, room).join('')}${suffix}`
}

export function emptyFormModel(): TaskFormModel {
  return {
    name: '',
    mode: 'curl',
    curl: '',
    url: '',
    method: 'GET',
    headers: '',
    body: '',
    scheduleKind: 'daily',
    dailyMode: 'range',
    windowStart: '',
    windowEnd: '',
    exactTime: '',
    jitterMinutes: 5,
    intervalValue: 1,
    intervalUnit: 60,
    intervalStart: '',
    intervalJitter: 0,
    runOnStartup: false,
    notifyEnabled: false,
    notifyCurl: '',
    expectStatus: '',
    expectBody: '',
    expectExpr: '',
    conditions: emptyCondition(),
  }
}

/** 已有任务 → 表单模型（与旧版 setEditMode 的映射保持一致）。 */
export function formModelFromTask(task: Task): TaskFormModel {
  const model = emptyFormModel()
  model.name = task.name
  model.scheduleKind = task.schedule_kind === 'interval' ? 'interval' : 'daily'
  model.windowStart = task.window_start || ''
  model.windowEnd = task.window_end || ''

  if (model.scheduleKind === 'daily') {
    const jitter = task.daily_jitter_minutes ?? 0
    const exact = task.window_start === task.window_end
    model.dailyMode = !exact ? 'range' : jitter > 0 ? 'jitter' : 'exact'
    if (exact) {
      model.exactTime = task.window_start
      model.jitterMinutes = jitter > 0 ? jitter : 5
    }
  } else {
    const seconds = Number(task.interval_seconds) || 60
    model.intervalUnit =
      seconds % 86400 === 0
        ? 86400
        : seconds % 3600 === 0
          ? 3600
          : seconds % 60 === 0
            ? 60
            : 1
    model.intervalValue = Math.max(1, Math.round(seconds / model.intervalUnit))
    model.intervalJitter = task.interval_jitter_seconds ?? 0
    model.intervalStart =
      task.interval_start_at === null || task.interval_start_at === undefined
        ? ''
        : toDateTimeLocal(task.interval_start_at)
  }

  model.mode = task.curl_command !== null ? 'curl' : 'structured'
  model.curl = task.curl_command ?? ''
  model.url = task.request_url ?? ''
  model.method = task.request_method ?? 'GET'
  model.headers = headersToText(task.request_headers)
  model.body = task.request_body ?? ''

  model.notifyEnabled = task.notify_enabled === 1
  model.notifyCurl = task.notify_curl_command ?? ''
  model.expectStatus =
    task.expect_status === null || task.expect_status === undefined ? '' : String(task.expect_status)
  model.expectBody = task.expect_body ?? ''
  model.expectExpr = task.expect_expr ?? ''
  model.runOnStartup = task.run_on_startup === 1
  model.conditions = conditionFromTask(task)
  return model
}

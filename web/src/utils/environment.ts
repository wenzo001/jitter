import type { HostEnvironment } from '@/types/system'

/** 当前电源 / 本机 IP 提示：编辑任务时帮助填写 IP 条件。 */
export function describeHostEnvironment(env: HostEnvironment | null | undefined): string {
  if (!env) return ''
  const power =
    env.onAcPower === true ? '已接通电源' : env.onAcPower === false ? '电池供电' : '电源状态未知'
  const ips =
    Array.isArray(env.localIps) && env.localIps.length > 0 ? env.localIps.join(', ') : '未读取到'
  return `当前电源：${power} · 当前本机 IP：${ips}`
}

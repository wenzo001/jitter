import type { HostEnvironment } from '@/types/system'
import { zhTranslate, type TranslateFn } from '@/locales/current'

/** 当前电源 / 本机 IP 提示：编辑任务时帮助填写 IP 条件。 */
export function describeHostEnvironment(
  env: HostEnvironment | null | undefined,
  t: TranslateFn = zhTranslate,
): string {
  if (!env) return ''
  const power =
    env.onAcPower === true
      ? t('env.onAc')
      : env.onAcPower === false
        ? t('env.onBattery')
        : t('env.unknown')
  const ips =
    Array.isArray(env.localIps) && env.localIps.length > 0
      ? env.localIps.join(', ')
      : t('env.ipsUnavailable')
  return t('env.summary', { power, ips })
}

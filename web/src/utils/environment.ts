import type { HostEnvironment, HostNetwork } from '@/types/system'
import { zhTranslate, type TranslateFn } from '@/locales/current'

/** 网络类型的展示文案。 */
function networkKindLabel(network: HostNetwork, t: TranslateFn): string {
  if (network.kind === 'wifi') return t('env.networkWifi')
  if (network.kind === 'ethernet') return t('env.networkEthernet')
  return t('env.networkOther')
}

/** 一个网卡的展示文案：网卡名跟类型重复时不再重复括号。 */
function networkTextOf(network: HostNetwork, t: TranslateFn): string {
  const label = networkKindLabel(network, t)
  return network.name && network.name !== label ? `${label}（${network.name}）` : label
}

/** 当前网络提示：只讲网络，用于「已连接网络」条件下方。 */
export function describeHostNetwork(
  env: HostEnvironment | null | undefined,
  t: TranslateFn = zhTranslate,
): string {
  if (!env) return ''
  const networks = Array.isArray(env.networks) ? env.networks : []
  if (networks.length === 0) return t('env.networkNone')
  return networks.map((item) => networkTextOf(item, t)).join('、')
}

/** 当前电源 / 网络 / 本机 IP 提示：编辑任务时帮助填写条件。 */
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
  const networks = Array.isArray(env.networks) ? env.networks : []
  const network =
    networks.length > 0 ? networks.map((item) => networkTextOf(item, t)).join('、') : t('env.networkNone')
  return t('env.summary', { power, network, ips })
}

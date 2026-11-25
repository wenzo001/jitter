import { describe, expect, it } from 'vitest'
import { copiedTaskName } from '@/types/form'

describe('复制任务的默认名字', () => {
  it('在原名后加副本后缀', () => {
    expect(copiedTaskName('每日签到', ' - 副本')).toBe('每日签到 - 副本')
    expect(copiedTaskName('每日签到', ' (copy)')).toBe('每日签到 (copy)')
  })

  it('原名首尾空白会被去掉', () => {
    expect(copiedTaskName('  每日签到  ', ' - 副本')).toBe('每日签到 - 副本')
  })

  it('超长时截断原名，后缀一定保留', () => {
    const name = 'a'.repeat(300)
    const result = copiedTaskName(name, ' - 副本')
    expect(result.length).toBe(200)
    expect(result.endsWith(' - 副本')).toBe(true)
  })

  it('按码点截断，不切坏 emoji', () => {
    const name = '🙂'.repeat(10)
    // 上限 8 个字符，后缀「 - 副本」占 5 个，原名只剩 3 个位置。
    const result = copiedTaskName(name, ' - 副本', 8)
    expect(result).toBe(`${'🙂'.repeat(3)} - 副本`)
    expect([...result].length).toBe(8)
  })
})

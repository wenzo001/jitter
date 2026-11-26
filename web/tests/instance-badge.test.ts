import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '@/stores/app'
import type { SystemInfo } from '@/types/system'

function infoOf(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    name: 'Jitter',
    version: '2.1.18',
    instance: 'prod',
    default_instance: true,
    platform: 'win32',
    arch: 'x64',
    compiled: true,
    binary_path: 'C:/Apps/jitter.exe',
    install_dir: 'C:/Apps',
    config_dir: 'C:/Users/t/AppData/Roaming/Jitter',
    db_path: 'C:/Apps/data/app.db',
    autostart: false,
    autostart_path: 'C:/Users/t/AppData/Roaming/.../Jitter.cmd',
    url: 'http://127.0.0.1:3000',
    port: 3000,
    ...overrides,
  }
}

describe('实例标识', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('生产实例默认是 prod，且算作默认实例', () => {
    const app = useAppStore()
    app.system = infoOf()
    expect(app.instance).toBe('prod')
    expect(app.isDefaultInstance).toBe(true)
  })

  it('非生产实例会暴露自己的名字', () => {
    const app = useAppStore()
    app.system = infoOf({ instance: 'dev', default_instance: false })
    expect(app.instance).toBe('dev')
    expect(app.isDefaultInstance).toBe(false)
  })

  it('还没拿到系统信息时按生产实例处理', () => {
    const app = useAppStore()
    expect(app.system).toBeNull()
    expect(app.instance).toBe('prod')
    expect(app.isDefaultInstance).toBe(true)
  })
})

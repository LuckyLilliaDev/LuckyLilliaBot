import { describe, expect, it } from 'vitest'
import { basePath, instanceHref, instanceStorageKey, pageInstance, withBase } from '@/plugin/internal/service/webui/FE/utils/base'

describe('WebUI base-path helpers', () => {
  it('extracts base path and instance name from /i/<instance>/', () => {
    expect(basePath('/')).toBe('')
    expect(pageInstance('/')).toBeUndefined()
    expect(basePath('/i/default/')).toBe('/i/default')
    expect(pageInstance('/i/default/')).toBe('default')
    expect(basePath('/i/bot-2/sub/path')).toBe('/i/bot-2')
    expect(pageInstance('/i/bot-2/sub/path')).toBe('bot-2')
  })

  it('prefixes instance root paths while keeping manager API, relative paths, and already-prefixed URLs untouched', () => {
    expect(withBase('/api/config', '/i/bot2/')).toBe('/i/bot2/api/config')
    expect(withBase('/face/0.png', '/i/bot2/')).toBe('/i/bot2/face/0.png')
    expect(withBase('/i/bot2/api/config', '/i/bot2/')).toBe('/i/bot2/api/config')
    expect(withBase('/api/manager/instances', '/i/bot2/')).toBe('/api/manager/instances')
    expect(withBase('/api/manager', '/i/bot2/')).toBe('/api/manager')
    expect(withBase('logo-128.webp', '/i/bot2/')).toBe('logo-128.webp')
    expect(withBase('//cdn.example.com/a.js', '/i/bot2/')).toBe('//cdn.example.com/a.js')
    expect(withBase('https://example.com/x', '/i/bot2/')).toBe('https://example.com/x')
    expect(withBase('/api/config', '/')).toBe('/api/config')
  })

  it('formats instance URLs and per-instance storage keys', () => {
    expect(instanceHref('bot-2')).toBe('/i/bot-2/')
    expect(instanceStorageKey('llbot-plugins-layout', '/')).toBe('llbot-plugins-layout')
    expect(instanceStorageKey('llbot-plugins-layout', '/i/bot-2/')).toBe('llbot-plugins-layout:bot-2')
  })
})

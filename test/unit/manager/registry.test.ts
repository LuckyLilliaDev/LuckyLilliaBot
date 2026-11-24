import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Registry } from '@/main/manager/registry'

let dir: string
const log = { info: vi.fn(), warn: vi.fn() }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-registry-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const instance = (name: string, settings?: unknown) => {
  mkdirSync(path.join(dir, 'instances', name), { recursive: true })
  if (settings) writeFileSync(path.join(dir, 'instances', name, 'settings.json'), JSON.stringify(settings))
}

describe('the instance registry', () => {
  it('writes manager.json on the first start, the gateway at the address the default instance\'s WebUI had', () => {
    instance('default', { webui: { host: '', port: 3099 } })
    const config = new Registry(dir, log).load()
    expect(config).toEqual({
      gateway: { host: '', port: 3099 },
      defaultInstance: 'default',
      instances: { default: { autostart: true } },
    })
    expect(JSON.parse(readFileSync(path.join(dir, 'manager.json'), 'utf8'))).toEqual(config)
  })

  it('defaults to 127.0.0.1:3080 and seeds default directory on a brand-new install', () => {
    const registry = new Registry(dir, log)
    expect(registry.load().gateway).toEqual({ host: '127.0.0.1', port: 3080 })
    expect(registry.list()).toEqual(['default'])
    expect(existsSync(path.join(dir, 'instances', 'default'))).toBe(true)
  })

  it('lists the default instance first, then the other directories in order, skipping names that are not valid', () => {
    instance('default')
    instance('zeta')
    instance('alpha')
    instance('_hidden')
    expect(new Registry(dir, log).list()).toEqual(['default', 'alpha', 'zeta'])
  })

  it('starts the instances marked autostart that exist, and saves a change', () => {
    instance('default')
    instance('bot2')
    const registry = new Registry(dir, log)
    registry.setAutostart('bot2', true)
    registry.setAutostart('gone', true)
    expect(registry.autostart()).toEqual(['default', 'bot2'])
    expect(new Registry(dir, log).settings('bot2')).toEqual({ autostart: true })
  })

  it('runs on defaults without overwriting a manager.json that is not valid JSON', () => {
    instance('default')
    writeFileSync(path.join(dir, 'manager.json'), '{ broken')
    const config = new Registry(dir, log).load()
    expect(config.instances).toEqual({ default: { autostart: true } })
    expect(readFileSync(path.join(dir, 'manager.json'), 'utf8')).toBe('{ broken')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('不是有效的 JSON'))
  })

  it('keeps an instance not to start when the file says so', () => {
    instance('default')
    writeFileSync(path.join(dir, 'manager.json'), JSON.stringify({ gateway: { host: '0.0.0.0', port: 3100 }, instances: { default: { autostart: false } } }))
    const registry = new Registry(dir, log)
    expect(registry.autostart()).toEqual([])
    expect(registry.load().gateway).toEqual({ host: '0.0.0.0', port: 3100 })
    expect(existsSync(path.join(dir, 'manager.json'))).toBe(true)
  })

  it('creates, renames, and removes instances including default down to 0 instances without recreating default', () => {
    const registry = new Registry(dir, log)
    registry.create('bot2', { autostart: true })
    expect(registry.exists('bot2')).toBe(true)
    expect(registry.list()).toEqual(['default', 'bot2'])
    expect(registry.settings('bot2')).toEqual({ autostart: true })

    // Duplicate and invalid names rejected
    expect(() => registry.create('bot2')).toThrow(/已存在/)
    expect(() => registry.create('_bad')).toThrow()

    // Stale state file cleaned on rename
    const stateDir = path.join(dir, 'state', 'instances')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, 'bot2.json'), '{}')
    writeFileSync(path.join(dir, 'instances', 'bot2', 'marker.txt'), 'ok')

    registry.rename('bot2', 'bot-two')
    expect(registry.exists('bot2')).toBe(false)
    expect(registry.exists('bot-two')).toBe(true)
    expect(readFileSync(path.join(dir, 'instances', 'bot-two', 'marker.txt'), 'utf8')).toBe('ok')
    expect(existsSync(path.join(stateDir, 'bot2.json'))).toBe(false)
    expect(registry.settings('bot-two')).toEqual({ autostart: true })

    // Renaming default updates defaultInstance and persists across reload without recreating default
    registry.rename('default', 'main-bot')
    expect(registry.exists('default')).toBe(false)
    expect(registry.defaultInstance()).toBe('main-bot')
    expect(new Registry(dir, log).list()).toEqual(['main-bot', 'bot-two'])
    expect(new Registry(dir, log).defaultInstance()).toBe('main-bot')

    // Removing the default instance promotes the next remaining instance
    writeFileSync(path.join(stateDir, 'main-bot.json'), '{}')
    registry.remove('main-bot')
    expect(registry.exists('main-bot')).toBe(false)
    expect(existsSync(path.join(stateDir, 'main-bot.json'))).toBe(false)
    expect(registry.defaultInstance()).toBe('bot-two')
    expect(new Registry(dir, log).list()).toEqual(['bot-two'])

    // Removing the last remaining instance leaves 0 instances and stays empty across reload
    registry.remove('bot-two')
    expect(registry.list()).toEqual([])
    expect(registry.defaultInstance()).toBeUndefined()
    const reloaded = new Registry(dir, log)
    expect(reloaded.list()).toEqual([])
    expect(reloaded.defaultInstance()).toBeUndefined()
    expect(reloaded.autostart()).toEqual([])

    // Creating a new instance from 0 sets it as the new defaultInstance
    reloaded.create('fresh', { autostart: true })
    expect(reloaded.list()).toEqual(['fresh'])
    expect(reloaded.defaultInstance()).toBe('fresh')
  })

  it('updates and validates gateway host and port in manager.json', () => {
    const registry = new Registry(dir, log)
    expect(registry.setGateway({ host: '0.0.0.0', port: 4080 })).toEqual({ host: '0.0.0.0', port: 4080 })
    expect(new Registry(dir, log).load().gateway).toEqual({ host: '0.0.0.0', port: 4080 })
    expect(() => registry.setGateway({ port: 70000 })).toThrow(/端口/)
  })
})

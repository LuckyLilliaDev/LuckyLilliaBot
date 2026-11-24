import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagerApi, type GatewayLock, type InstanceHandle } from '@/main/manager/api'
import { GatewayAuth, hashPassword } from '@/main/manager/auth'
import { Gateway } from '@/main/manager/gateway'
import type { InstancePhase, InstanceStatus } from '@/main/manager/instance'
import { Registry } from '@/main/manager/registry'

const PASSWORD = 'pw'
const TOKEN = hashPassword(PASSWORD)

class FakeInstance implements InstanceHandle {
  phase: InstancePhase = 'stopped'
  logs: string[] = []
  constructor(readonly name: string) {}
  status(): InstanceStatus {
    return { name: this.name, phase: this.phase, ...this.phase === 'running' ? { pid: 1234 } : {} }
  }
  recentOutput(): string[] {
    return [...this.logs]
  }
  start(): void {
    this.phase = 'running'
    this.logs.push(`started ${this.name}`)
  }
  async stop(): Promise<void> {
    this.phase = 'stopped'
    this.logs.push(`stopped ${this.name}`)
  }
  async restart(): Promise<void> {
    await this.stop()
    this.start()
  }
}

let dir: string
let gateway: Gateway
let base: string
let registry: Registry
let fakes: Map<string, FakeInstance>
let lockedExternal: Set<string>
let envLocked: GatewayLock[]
let onGatewayChanged: ReturnType<typeof vi.fn>
let listening = 3080

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-manager-api-'))
  registry = new Registry(dir, { info: () => {}, warn: () => {} })
  registry.load()
  fakes = new Map()
  lockedExternal = new Set()
  envLocked = []
  onGatewayChanged = vi.fn()
  let selected = 'default'

  const getFake = (name: string) => {
    let fake = fakes.get(name)
    if (!fake) {
      fake = new FakeInstance(name)
      fakes.set(name, fake)
    }
    return fake
  }

  const auth = new GatewayAuth({ file: path.join(dir, 'webui_token.txt') })
  auth.setToken(PASSWORD)

  const manager = createManagerApi({
    registry,
    selected: () => selected,
    statusOf: name => fakes.get(name)?.status() ?? { name, phase: 'stopped' },
    recentOutput: name => fakes.get(name)?.recentOutput() ?? [],
    instance: getFake,
    isLockedExternal: async name => lockedExternal.has(name),
    onRenamed: (from, to) => {
      fakes.delete(from)
      if (selected === from) selected = to
    },
    onRemoved: name => {
      fakes.delete(name)
    },
    gatewayState: () => ({
      host: registry.load().gateway.host,
      port: registry.load().gateway.port,
      listening,
      envLocked,
    }),
    onGatewayChanged,
  })

  gateway = new Gateway({
    auth,
    secret: 'secret',
    lookup: () => undefined,
    defaultInstance: () => selected,
    manager,
  })
  listening = await gateway.listen('127.0.0.1', 0)
  base = `http://127.0.0.1:${listening}`
})

afterEach(async () => {
  await gateway.close()
  rmSync(dir, { recursive: true, force: true })
})

const req = (route: string, init: RequestInit = {}) =>
  fetch(`${base}${route}`, {
    ...init,
    headers: { 'x-webui-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  })

describe('manager API', () => {
  it('creates, starts, logs, stops, renames, toggles autostart, and deletes an instance', async () => {
    // Create + start immediately
    const created = await req('/api/manager/instances', {
      method: 'POST',
      body: JSON.stringify({ name: 'bot2', autostart: true, start: true }),
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({
      success: true,
      data: { name: 'bot2', phase: 'running', autostart: true, isDefault: false },
    })

    // Logs show startup output
    const logs = await (await req('/api/manager/instances/bot2/logs')).json()
    expect(logs).toEqual({ success: true, data: { name: 'bot2', lines: ['started bot2'] } })

    // Renaming to an existing instance fails with 409 without stopping the running instance
    expect((await req('/api/manager/instances/bot2', { method: 'PATCH', body: JSON.stringify({ renameTo: 'default' }) })).status).toBe(409)
    expect(fakes.get('bot2')?.phase).toBe('running')

    // Renaming while running stops, moves, and restarts the instance under the new name
    const renamedRunning = await req('/api/manager/instances/bot2', {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'bot2-live' }),
    })
    expect(renamedRunning.status).toBe(200)
    expect(await renamedRunning.json()).toMatchObject({
      success: true,
      data: { name: 'bot2-live', phase: 'running', autostart: true },
    })

    // Stop, then rename + turn off autostart
    expect((await req('/api/manager/instances/bot2-live/stop', { method: 'POST' })).status).toBe(200)
    const renamed = await req('/api/manager/instances/bot2-live', {
      method: 'PATCH',
      body: JSON.stringify({ renameTo: 'bot3', autostart: false }),
    })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      success: true,
      data: { name: 'bot3', phase: 'stopped', autostart: false },
    })

    // External lock blocks deletion
    lockedExternal.add('bot3')
    expect((await req('/api/manager/instances/bot3', { method: 'DELETE' })).status).toBe(409)
    lockedExternal.delete('bot3')

    // Start bot3 again and delete while running: automatically stops and removes it
    expect((await req('/api/manager/instances/bot3/start', { method: 'POST' })).status).toBe(200)
    expect(fakes.get('bot3')?.phase).toBe('running')
    expect((await req('/api/manager/instances/bot3', { method: 'DELETE' })).status).toBe(200)
    const list = await (await req('/api/manager/instances')).json()
    expect(list.data.instances.map((i: { name: string }) => i.name)).toEqual(['default'])
  })

  it('allows renaming and deleting default down to 0 instances', async () => {
    expect((await req('/api/manager/instances/default', { method: 'PATCH', body: JSON.stringify({ autostart: false }) })).status).toBe(200)
    const renamed = await req('/api/manager/instances/default', { method: 'PATCH', body: JSON.stringify({ renameTo: 'main' }) })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      success: true,
      data: { name: 'main', isDefault: true, autostart: false },
    })
    expect((await req('/api/manager/instances/main', { method: 'DELETE' })).status).toBe(200)
    const list = await (await req('/api/manager/instances')).json()
    expect(list.data.instances).toEqual([])
  })

  it('reads and updates gateway settings while respecting envLocked fields', async () => {
    envLocked = [{ path: 'webui.port', by: '--webui-port' }]
    const initial = await (await req('/api/manager/gateway')).json()
    expect(initial.data).toMatchObject({ host: '127.0.0.1', port: 3080, listening, envLocked })

    const updated = await req('/api/manager/gateway', {
      method: 'PATCH',
      body: JSON.stringify({ host: '0.0.0.0', port: 9999 }),
    })
    expect(updated.status).toBe(200)
    const body = await updated.json()
    // Port was locked so only host changed
    expect(body.data).toMatchObject({ host: '0.0.0.0', port: 3080, restarted: true })

    await new Promise(resolve => setTimeout(resolve, 200))
    expect(onGatewayChanged).toHaveBeenCalledWith('0.0.0.0', 3080)
  })

  it('exposes host network interfaces for the gateway HostSelector', async () => {
    const res = await req('/api/manager/network-interfaces')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })
})

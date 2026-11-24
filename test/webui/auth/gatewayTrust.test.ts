import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { behindGateway, fromGateway, gatewayAuthenticated } from '@/plugin/internal/service/webui/BE/gateway'
import { authMiddleware } from '@/plugin/internal/service/webui/BE/auth'
import { servePluginAsset } from '@/plugin/internal/service/webui/BE/routes/plugins'

const dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-gateway-trust-'))
const module = path.join(dir, 'index.js')
writeFileSync(module, 'export default () => {}')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const saved = { managed: process.env.LLBOT_MANAGED, secret: process.env.LLBOT_GATEWAY_SECRET }
beforeEach(() => {
  process.env.LLBOT_MANAGED = '1'
  process.env.LLBOT_GATEWAY_SECRET = 'secret'
})
afterEach(() => {
  for (const [key, value] of [['LLBOT_MANAGED', saved.managed], ['LLBOT_GATEWAY_SECRET', saved.secret]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const fromTheGateway = { 'x-llbot-gateway': 'secret', 'x-llbot-auth': 'ok' }

describe('an instance behind the manager\'s gateway', () => {
  it('knows it is, and tells the gateway\'s requests by the secret', () => {
    expect(behindGateway()).toBe(true)
    expect(behindGateway({ LLBOT_MANAGED: '1' })).toBe(false)
    const headers = (values: Record<string, string>) => (name: string) => values[name]
    expect(fromGateway(headers({ 'x-llbot-gateway': 'secret' }))).toBe(true)
    expect(fromGateway(headers({ 'x-llbot-gateway': 'other' }))).toBe(false)
    expect(gatewayAuthenticated(headers({ 'x-llbot-gateway': 'secret' }))).toBe(false)
    expect(gatewayAuthenticated(headers(fromTheGateway))).toBe(true)
    // The login mark means nothing without the secret
    expect(gatewayAuthenticated(headers({ 'x-llbot-auth': 'ok' }))).toBe(false)
  })

  it('trusts the login the gateway checked instead of its own', async () => {
    const app = new Hono()
    app.use('/api/*', authMiddleware)
    app.get('/api/config', c => c.json({ success: true }))
    expect((await app.request('/api/config', { headers: fromTheGateway })).status).toBe(200)
    const refused = await app.request('/api/config', { headers: { 'x-llbot-gateway': 'secret', 'x-webui-token': 'anything' } })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('x-webui-auth')).toBe('required')
  })

  it('serves plugin modules the gateway let through', async () => {
    const ctx = { plugins: { webuiAsset: vi.fn(() => module) } } as unknown as Context
    const get = (headers: Record<string, string>) => servePluginAsset(ctx, new Request('http://localhost/plugin-webui/x/1/index.js', { headers }))
    expect((await get(fromTheGateway)).status).toBe(200)
    expect((await get({ 'x-llbot-gateway': 'secret' })).status).toBe(401)
    expect((await get({ 'x-llbot-auth': 'ok' })).status).toBe(401)
  })
})

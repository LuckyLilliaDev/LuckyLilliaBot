import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GatewayAuth, hashPassword } from '@/main/manager/auth'
import { Gateway, routeOf, type GatewayTarget } from '@/main/manager/gateway'
import type { InstancePhase } from '@/main/manager/instance'

const SECRET = 'gateway-secret'
const PASSWORD = 'pw'
const TOKEN = hashPassword(PASSWORD)

/** A stand-in instance WebUI: echoes what it got, streams events, counts upload bytes */
function upstream(name: string) {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
      // The second event only after the client saw the first: proves nothing buffers it
      const timer = setTimeout(() => response.end('data: second\n\n'), 300)
      request.on('close', () => clearTimeout(timer))
      return
    }
    if (request.url === '/api/upload') {
      let size = 0
      request.on('data', chunk => size += chunk.length)
      request.on('end', () => response.end(JSON.stringify({ size })))
      return
    }
    response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html' : 'application/json', 'set-cookie': 'app=1; Path=/' })
    response.end(JSON.stringify({ instance: name, method: request.method, url: request.url, headers: request.headers }))
  })
  return server
}

const servers = { default: upstream('default'), second: upstream('second') }
const phases: Record<string, InstancePhase> = { default: 'running', second: 'running', third: 'starting' }
let dir: string
let gateway: Gateway
let base: string
let auth: GatewayAuth

beforeAll(async () => {
  await Promise.all(Object.values(servers).map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))))
})
afterAll(async () => {
  await Promise.all(Object.values(servers).map(server => new Promise(resolve => server.close(resolve))))
})

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-gateway-'))
  auth = new GatewayAuth({ file: path.join(dir, 'webui_token.txt') })
  gateway = new Gateway({
    auth,
    secret: SECRET,
    lookup: (name): GatewayTarget | undefined => {
      if (!(name in phases)) return undefined
      const server = servers[name as keyof typeof servers]
      return { name, phase: phases[name], port: phases[name] === 'running' ? (server.address() as AddressInfo).port : undefined }
    },
    defaultInstance: () => 'default',
    manager: async (_request, response, route) => {
      if (route !== '/api/manager/instances') return false
      response.end(JSON.stringify({ success: true }))
      return true
    },
  })
  const port = await gateway.listen('127.0.0.1', 0)
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => {
  await gateway.close()
  rmSync(dir, { recursive: true, force: true })
})

const echo = async (response: Response) => (await response.json()) as { instance: string; url: string; headers: Record<string, string> }
const withLogin = (headers: Record<string, string> = {}) => ({ 'x-webui-token': TOKEN, ...headers })

describe('choosing the instance of a request', () => {
  it('takes the one the path names, then the one of the page, then the remembered one, then the default', () => {
    expect(routeOf('/i/bot2/api/x', {}, 'default')).toEqual({ instance: 'bot2', prefix: '/i/bot2', path: '/api/x' })
    expect(routeOf('/i/bot2', {}, 'default')).toBe('redirect')
    expect(routeOf('/i/_bad/x', {}, 'default')).toBeUndefined()
    expect(routeOf('/api/x', { referer: 'http://h:3080/i/bot2/#/plugins' }, 'default')).toMatchObject({ instance: 'bot2', prefix: '' })
    expect(routeOf('/api/x', { cookie: 'a=1; llbot_instance=bot3' }, 'default')).toMatchObject({ instance: 'bot3' })
    expect(routeOf('/api/x', { referer: 'http://h:3080/' }, 'default')).toMatchObject({ instance: 'default', path: '/api/x' })
  })
})

describe('the gateway', () => {
  it('asks for a first password, sets it, and keeps the WebUI\'s login protocol', async () => {
    const unset = await fetch(`${base}/api/login-info`)
    expect(unset.status).toBe(401)
    expect(unset.headers.get('x-webui-auth')).toBe('unset')
    const set = await fetch(`${base}/api/set-token`, { method: 'POST', body: JSON.stringify({ token: PASSWORD }) })
    expect(await set.json()).toMatchObject({ success: true })
    const required = await fetch(`${base}/api/login-info`)
    expect(required.status).toBe(403)
    expect(required.headers.get('x-webui-auth')).toBe('required')
    // Changing it takes the current one
    expect((await fetch(`${base}/i/second/api/set-token`, { method: 'POST', body: JSON.stringify({ token: 'x' }) })).status).toBe(403)
  })

  it('forwards a logged-in request with its secret and without the password', async () => {
    auth.setToken(PASSWORD)
    const response = await fetch(`${base}/api/config?token=${TOKEN}&a=1`, {
      headers: withLogin({ cookie: `webui_token_3080=${TOKEN}; theme=dark`, 'x-llbot-gateway': 'forged', 'x-forwarded-for': '9.9.9.9' }),
    })
    const got = await echo(response)
    expect(got.instance).toBe('default')
    expect(got.url).toBe('/api/config?a=1')
    expect(got.headers['x-llbot-gateway']).toBe(SECRET)
    expect(got.headers['x-llbot-auth']).toBe('ok')
    expect(got.headers['x-llbot-instance']).toBe('default')
    expect(got.headers['x-forwarded-prefix']).toBe('')
    expect(got.headers['x-webui-token']).toBeUndefined()
    expect(got.headers.cookie).toBe('theme=dark')
    expect(got.headers['x-forwarded-for']).toMatch(/^9\.9\.9\.9, /)
  })

  it('routes /i/<name>/ to that instance without the prefix, and redirects the bare name', async () => {
    auth.setToken(PASSWORD)
    const got = await echo(await fetch(`${base}/i/second/api/x`, { headers: withLogin() }))
    expect(got).toMatchObject({ instance: 'second', url: '/api/x' })
    expect(got.headers['x-forwarded-prefix']).toBe('/i/second')
    const redirect = await fetch(`${base}/i/second?x=1`, { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/i/second/?x=1')
  })

  it('remembers the instance a page was opened on, for requests of that tab without a prefix', async () => {
    const page = await fetch(`${base}/i/second/`, { headers: { accept: 'text/html' } })
    const cookies = page.headers.getSetCookie()
    expect(cookies).toContain('app=1; Path=/')
    expect(cookies).toContain('llbot_instance=second; Path=/; SameSite=Lax')
    auth.setToken(PASSWORD)
    const byReferer = await echo(await fetch(`${base}/api/x`, { headers: withLogin({ referer: `${base}/i/second/` }) }))
    expect(byReferer.instance).toBe('second')
  })

  it('checks the cookie of module imports and images, and does not let a forged login through', async () => {
    auth.setToken(PASSWORD)
    expect((await fetch(`${base}/plugin-webui/x/1/index.js`)).status).toBe(401)
    const port = new URL(base).port
    const module = await echo(await fetch(`${base}/plugin-webui/x/1/index.js`, { headers: { cookie: `webui_token_${port}=${TOKEN}` } }))
    expect(module.headers['x-llbot-auth']).toBe('ok')
    const page = await echo(await fetch(`${base}/telegram/webhook/1`, { method: 'POST', headers: { 'x-llbot-auth': 'ok' } }))
    expect(page.headers['x-llbot-auth']).toBeUndefined()
  })

  it('says when an instance is not running, as JSON to the API and as a page that waits for it', async () => {
    auth.setToken(PASSWORD)
    const api = await fetch(`${base}/i/third/api/x`, { headers: withLogin() })
    expect(api.status).toBe(503)
    expect(await api.json()).toMatchObject({ success: false, data: { instance: 'third', phase: 'starting' } })
    const page = await fetch(`${base}/i/third/`)
    expect(page.status).toBe(503)
    expect(page.headers.get('refresh')).toBe('2')
    expect(await page.text()).toContain('实例 third 正在启动')
    expect((await fetch(`${base}/i/nobody/api/x`, { headers: withLogin() })).status).toBe(404)
  })

  it('passes server-sent events on as they come', async () => {
    auth.setToken(PASSWORD)
    const response = await fetch(`${base}/api/stream?token=${TOKEN}`)
    const reader = response.body!.getReader()
    const started = Date.now()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('data: first')
    expect(Date.now() - started).toBeLessThan(250)
    await reader.cancel()
  })

  it('streams an upload through', async () => {
    auth.setToken(PASSWORD)
    const body = Buffer.alloc(5 * 1024 * 1024, 1)
    const response = await fetch(`${base}/api/upload`, { method: 'POST', headers: withLogin(), body })
    expect(await response.json()).toEqual({ size: body.length })
  })

  it('serves the manager API behind the login', async () => {
    auth.setToken(PASSWORD)
    expect((await fetch(`${base}/api/manager/instances`)).status).toBe(403)
    expect(await (await fetch(`${base}/api/manager/instances`, { headers: withLogin() })).json()).toEqual({ success: true })
    expect((await fetch(`${base}/api/manager/nothing`, { headers: withLogin() })).status).toBe(404)
  })

  it('serves root WebUI static files directly even when all instances are stopped, while forwarding unknown public paths', async () => {
    const webuiDir = path.join(dir, 'webui')
    mkdirSync(path.join(webuiDir, 'assets'), { recursive: true })
    writeFileSync(path.join(webuiDir, 'index.html'), '<html><body>manager-overview</body></html>')
    writeFileSync(path.join(webuiDir, 'assets', 'app.js'), 'console.log(1)')

    const staticGateway = new Gateway({
      auth,
      secret: SECRET,
      lookup: (name) => name === 'default' ? { name, phase: 'stopped' } : name === 'second' ? { name, phase: 'running', port: (servers.second.address() as AddressInfo).port } : undefined,
      defaultInstance: () => 'default',
      webuiDir,
    })
    const port = await staticGateway.listen('127.0.0.1', 0)
    try {
      const root = await fetch(`http://127.0.0.1:${port}/`)
      expect(root.status).toBe(200)
      expect(root.headers.get('cache-control')).toBe('no-store')
      expect(await root.text()).toContain('manager-overview')
      const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('javascript')
      expect(asset.headers.get('cache-control')).toContain('immutable')

      // Stopped instance route `/i/default/` still serves the WebUI shell directly with no-store and remembers the instance
      const stoppedPage = await fetch(`http://127.0.0.1:${port}/i/default/`, { headers: { accept: 'text/html' } })
      expect(stoppedPage.status).toBe(200)
      expect(stoppedPage.headers.get('cache-control')).toBe('no-store')
      expect(stoppedPage.headers.getSetCookie()).toContain('llbot_instance=default; Path=/; SameSite=Lax')
      expect(await stoppedPage.text()).toContain('manager-overview')
      const stoppedAsset = await fetch(`http://127.0.0.1:${port}/i/default/assets/app.js`)
      expect(stoppedAsset.status).toBe(200)
      expect(stoppedAsset.headers.get('cache-control')).toContain('immutable')
      // API calls on the stopped instance still answer 503 JSON
      auth.setToken(PASSWORD)
      const stoppedApi = await fetch(`http://127.0.0.1:${port}/i/default/api/config`, { headers: withLogin() })
      expect(stoppedApi.status).toBe(503)

      // Traversal does not escape webuiDir
      const escaped = await fetch(`http://127.0.0.1:${port}/../webui_token.txt`)
      expect(escaped.status).not.toBe(200)

      // Public plugin path not in webuiDir still forwards to the instance (both prefixed and via Referer)
      const prefixedFace = await echo(await fetch(`http://127.0.0.1:${port}/i/second/face/0.png`))
      expect(prefixedFace).toMatchObject({ instance: 'second', url: '/face/0.png' })
      const face = await echo(await fetch(`http://127.0.0.1:${port}/face/0.png`, {
        headers: { referer: `http://127.0.0.1:${port}/i/second/` },
      }))
      expect(face).toMatchObject({ instance: 'second', url: '/face/0.png' })

      // Rebinding moves the listener cleanly to a new port
      const reboundPort = await staticGateway.rebind('127.0.0.1', 0)
      expect(reboundPort).not.toBe(port)
      const after = await fetch(`http://127.0.0.1:${reboundPort}/`)
      expect(after.status).toBe(200)
    } finally {
      await staticGateway.close()
    }
  })
})

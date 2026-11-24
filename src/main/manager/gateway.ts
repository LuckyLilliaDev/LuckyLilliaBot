import { createReadStream, statSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { isValidInstanceName } from '@/common/instanceName'
import type { GatewayAuth, LoginRefusal } from './auth'
import type { InstancePhase } from './instance'
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_INSTANCE_HEADER,
  GATEWAY_PREFIX_HEADER,
  GATEWAY_SECRET_HEADER,
} from './protocol'

export interface GatewayTarget {
  name: string
  phase: InstancePhase
  /** The instance's WebUI on 127.0.0.1 */
  port?: number
}

export interface GatewayOptions {
  auth: GatewayAuth
  secret: string
  /** An instance and where it listens; undefined when there is none of that name */
  lookup(name: string): GatewayTarget | undefined
  /** Where requests without an instance of their own go */
  defaultInstance(): string
  /** /api/manager/*, after the login passed; resolves false for a path it does not know */
  manager?(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>
  /** /api/core-update/*, after the login passed; handled centrally by the manager */
  coreUpdate?(request: IncomingMessage, response: ServerResponse, path: string, query: URLSearchParams): Promise<boolean>
  /** Built WebUI assets (dist/webui) served at `/` for the manager overview, independent of any running instance */
  webuiDir?: string
  log?: { info(message: string): void; warn(message: string): void }
}

/** The cookie that remembers which instance a tab last opened, for requests that name none */
export const INSTANCE_COOKIE = 'llbot_instance'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])
const MAX_JSON_BODY = 64 * 1024

/** `/i/<instance>/...` */
const PREFIXED = /^\/i\/([^/]+)(\/.*)?$/

export interface Route {
  instance: string
  /** `/i/<instance>` when the URL had it, else '' */
  prefix: string
  /** The path the instance sees */
  path: string
}

/**
 * Which instance a request is for: the one its path names (`/i/<name>/...`), else the one of the page that made it
 * (Referer: a plugin module importing or fetching a root path), else the one the tab last opened, else the default.
 */
export function routeOf(pathname: string, headers: http.IncomingHttpHeaders, fallback: string): Route | 'redirect' | undefined {
  const match = PREFIXED.exec(pathname)
  if (match) {
    let name: string
    try {
      name = decodeURIComponent(match[1])
    } catch {
      return undefined
    }
    if (!isValidInstanceName(name)) return undefined
    if (match[2] === undefined) return 'redirect'
    return { instance: name, prefix: `/i/${match[1]}`, path: match[2] }
  }
  const referer = headers.referer
  if (referer) {
    try {
      const fromReferer = PREFIXED.exec(new URL(referer).pathname)
      const name = fromReferer && decodeURIComponent(fromReferer[1])
      if (name && isValidInstanceName(name) && fromReferer[2] !== undefined) return { instance: name, prefix: '', path: pathname }
    } catch {
      // Not a URL
    }
  }
  const remembered = cookieOf(headers, INSTANCE_COOKIE)
  if (remembered && isValidInstanceName(remembered)) return { instance: remembered, prefix: '', path: pathname }
  return { instance: fallback, prefix: '', path: pathname }
}

export function cookieOf(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  for (const part of (headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim())
      } catch {
        return part.slice(index + 1).trim()
      }
    }
  }
}

/** The login cookie the WebUI keeps: named after the port the browser used (FE/utils/api.ts tokenCookieName) */
function loginCookieName(headers: http.IncomingHttpHeaders, secure: boolean): string {
  const port = /:(\d+)$/.exec(headers.host ?? '')?.[1] ?? (secure ? '443' : '80')
  return `webui_token_${port}`
}

/**
 * The one WebUI address of all instances: checks the login once and forwards each request to the instance it is
 * for, on 127.0.0.1, with the gateway's secret. Streams both ways, so server-sent events and large uploads pass as
 * they are.
 */
export class Gateway {
  readonly server: http.Server
  private readonly agent = new http.Agent({ keepAlive: true })
  private readonly sockets = new Set<Socket>()

  constructor(private readonly options: GatewayOptions) {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.options.log?.warn(`网关处理 ${request.method} ${request.url} 出错：${(error as Error).message}`)
        if (!response.headersSent) json(response, 500, { success: false, message: '网关内部错误' })
        else response.destroy()
      })
    })
    // An upload may take longer than the default five minutes; server-sent events never end
    this.server.requestTimeout = 0
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }

  /** Listens on `port`, else the next free one of the 100 after it; resolves to the port */
  async listen(host: string, port: number): Promise<number> {
    for (let candidate = port; candidate < port + 100 && candidate <= 65535; candidate++) {
      const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        const onError = (error: NodeJS.ErrnoException) => resolve(error)
        this.server.once('error', onError)
        this.server.listen(candidate, host || undefined, () => {
          this.server.off('error', onError)
          resolve(undefined)
        })
      })
      if (!error) {
        const address = this.server.address()
        return typeof address === 'object' && address ? address.port : candidate
      }
      if (error.code !== 'EADDRINUSE') throw error
      if (candidate === port) this.options.log?.warn(`端口 ${port} 已被占用，尝试后面的端口`)
    }
    throw new Error(`端口 ${port} 到 ${port + 99} 都被占用了`)
  }

  async close(): Promise<void> {
    await this.closeServer()
    this.agent.destroy()
  }

  /** Moves the listener to a new host / port while keeping the gateway and upstream pool alive */
  async rebind(host: string, port: number): Promise<number> {
    await this.closeServer()
    return await this.listen(host, port)
  }

  private async closeServer(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      for (const socket of this.sockets) socket.destroy()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://gateway')
    const route = routeOf(url.pathname, request.headers, this.options.defaultInstance())
    if (route === 'redirect') {
      response.writeHead(302, { location: `${url.pathname}/${url.search}` })
      response.end()
      return
    }
    if (!route) {
      text(response, 404, '没有这个实例')
      return
    }
    const ip = request.socket.remoteAddress ?? ''
    const method = request.method ?? 'GET'
    const presented = headerOf(request, 'x-webui-token') || url.searchParams.get('token') || undefined

    // The login of all instances is the gateway's: setting and changing the one password, whichever page asks
    if (route.path === '/api/set-token') {
      await this.setToken(request, response, presented, ip, url.pathname)
      return
    }
    if (route.path === '/api/manager' || route.path.startsWith('/api/manager/')) {
      const refusal = this.options.auth.check(presented, ip, method, url.pathname)
      if (refusal) return refuse(response, refusal)
      if (!(await this.options.manager?.(request, response, route.path))) json(response, 404, { success: false, message: '接口不存在' })
      return
    }
    if (this.options.coreUpdate && (route.path === '/api/core-update' || route.path.startsWith('/api/core-update/'))) {
      const refusal = this.options.auth.check(presented, ip, method, url.pathname)
      if (refusal) return refuse(response, refusal)
      if (!(await this.options.coreUpdate(request, response, route.path, url.searchParams))) json(response, 404, { success: false, message: '接口不存在' })
      return
    }

    // Serve the built WebUI shell directly for `/` and `/i/<name>/...` static files so the unified shell
    // (instance toolbar, status overlay, logs, gateway settings, core update) loads even when the instance is stopped.
    if (this.options.webuiDir && (method === 'GET' || method === 'HEAD')) {
      const staticPath = route.prefix ? route.path : url.pathname
      const extraHeaders: http.OutgoingHttpHeaders = {}
      if (route.prefix && isDocument(request) && this.options.lookup(route.instance)) {
        extraHeaders['set-cookie'] = `${INSTANCE_COOKIE}=${encodeURIComponent(route.instance)}; Path=/; SameSite=Lax`
      }
      if (this.serveStatic(response, staticPath, method === 'HEAD', extraHeaders)) {
        return
      }
    }

    let authenticated = false
    if (route.path.startsWith('/api/')) {
      const refusal = this.options.auth.check(presented, ip, method, url.pathname)
      if (refusal) return refuse(response, refusal)
      authenticated = true
    } else if (route.path.startsWith('/plugin-webui/') || route.path.startsWith('/plugin-assets/')) {
      // Module imports and images send cookies but no headers
      const secure = request.headers['x-forwarded-proto'] === 'https'
      const refusal = this.options.auth.check(cookieOf(request.headers, loginCookieName(request.headers, secure)), ip, method, url.pathname)
      if (refusal) {
        response.writeHead(401)
        response.end()
        return
      }
      authenticated = true
    } else {
      // Public routes and the page itself: the instance decides, knowing whether the login is there
      const secure = request.headers['x-forwarded-proto'] === 'https'
      authenticated = this.options.auth.matches(presented ?? cookieOf(request.headers, loginCookieName(request.headers, secure)))
    }

    const target = this.options.lookup(route.instance)
    if (!target) {
      if (route.path.startsWith('/api/')) json(response, 404, { success: false, message: `没有实例 ${route.instance}` })
      else text(response, 404, `没有实例 ${route.instance}`)
      return
    }
    if (!target.port) {
      unavailable(response, target, route.path)
      return
    }
    this.forward(request, response, url, route, target.port, authenticated)
  }

  private forward(request: IncomingMessage, response: ServerResponse, url: URL, route: Route, port: number, authenticated: boolean) {
    url.searchParams.delete('token')
    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith('x-llbot-') || name === 'x-webui-token') continue
      if (name === 'x-forwarded-for' || name === 'x-forwarded-proto' || name === 'x-forwarded-host' || name === GATEWAY_PREFIX_HEADER) continue
      headers[name] = value
    }
    // The password stays in the gateway
    const cookie = (request.headers.cookie ?? '').split(';').filter(part => !part.trim().startsWith('webui_token_')).join(';').trim()
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    const forwardedFor = request.headers['x-forwarded-for']
    headers['x-forwarded-for'] = [forwardedFor, request.socket.remoteAddress].flat().filter(Boolean).join(', ')
    headers['x-forwarded-proto'] = headerOf(request, 'x-forwarded-proto') || 'http'
    if (request.headers.host) headers['x-forwarded-host'] = request.headers.host
    headers[GATEWAY_PREFIX_HEADER] = route.prefix
    headers[GATEWAY_INSTANCE_HEADER] = route.instance
    headers[GATEWAY_SECRET_HEADER] = this.options.secret
    if (authenticated) headers[GATEWAY_AUTH_HEADER] = 'ok'

    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: request.method,
      path: route.path + url.search,
      headers,
      agent: this.agent,
    }, (upstreamResponse) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue
        out[name] = value
      }
      // A page opened under /i/<name>/: requests without a prefix of their own from this tab go to that instance.
      // Never let the browser heuristically cache the entry HTML, otherwise navigating back after stopping the
      // instance serves stale SPA markup instead of the gateway's 503 offline page.
      if (route.prefix && isDocument(request)) {
        const remember = `${INSTANCE_COOKIE}=${encodeURIComponent(route.instance)}; Path=/; SameSite=Lax`
        const existing = out['set-cookie']
        out['set-cookie'] = [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), remember]
        out['cache-control'] = 'no-store'
        delete out['last-modified']
        delete out.etag
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, out)
      // Server-sent events: each one as it comes
      if (String(upstreamResponse.headers['content-type'] ?? '').startsWith('text/event-stream')) response.flushHeaders()
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => {
      if (!response.headersSent) {
        if (route.path.startsWith('/api/')) json(response, 502, { success: false, message: `实例 ${route.instance} 没有响应：${error.message}` })
        else text(response, 502, `实例 ${route.instance} 没有响应：${error.message}`)
      } else response.destroy()
    })
    // The browser went away (a closed event stream, a cancelled upload): so does the request to the instance
    response.once('close', () => {
      if (!response.writableFinished) upstream.destroy()
    })
    request.pipe(upstream)
  }

  private async setToken(request: IncomingMessage, response: ServerResponse, presented: string | undefined, ip: string, url: string) {
    if (request.method !== 'POST') return json(response, 405, { success: false, message: '只接受 POST' })
    // Setting the first password is the one thing done without one
    if (this.options.auth.getToken()) {
      const refusal = this.options.auth.check(presented, ip, 'POST', url)
      if (refusal) return refuse(response, refusal)
    }
    let token: unknown
    try {
      token = (JSON.parse(await readBody(request)) as { token?: unknown }).token
    } catch {
      return json(response, 400, { success: false, message: '请求格式不对' })
    }
    if (typeof token !== 'string' || !token.trim()) return json(response, 400, { success: false, message: 'Token不能为空' })
    this.options.auth.setToken(token)
    json(response, 200, { success: true, message: 'Token设置成功' })
  }

  private serveStatic(
    response: ServerResponse,
    pathname: string,
    headOnly: boolean,
    extraHeaders: http.OutgoingHttpHeaders = {},
  ): boolean {
    if (pathname.startsWith('/api/') || pathname.startsWith('/plugin-webui/') || pathname.startsWith('/plugin-assets/')) return false
    const root = path.resolve(this.options.webuiDir!)
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return false
    }
    if (decoded.includes('\0')) return false
    const relative = decoded === '/' ? '/index.html' : decoded
    const file = path.resolve(root, '.' + relative)
    if (file !== root && !file.startsWith(root + path.sep)) return false
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(file)
    } catch {
      return false
    }
    if (!stat.isFile()) return false
    const ext = path.extname(file).toLowerCase()
    const isHtml = ext === '.html'
    const isHashedAsset = relative.startsWith('/assets/')
    response.writeHead(200, {
      ...extraHeaders,
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': isHtml ? 'no-store' : isHashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    })
    if (headOnly) {
      response.end()
      return true
    }
    const stream = createReadStream(file)
    stream.on('error', () => {
      if (!response.headersSent) response.writeHead(500)
      response.destroy()
    })
    stream.pipe(response)
    return true
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isDocument(request: IncomingMessage): boolean {
  const destination = request.headers['sec-fetch-dest']
  if (destination) return destination === 'document' || destination === 'iframe'
  return request.method === 'GET' && String(request.headers.accept ?? '').includes('text/html')
}

function refuse(response: ServerResponse, refusal: LoginRefusal) {
  // The WebUI asks for the password on these only (X-Webui-Auth), not on a 401 / 403 a route answers on its own
  json(response, refusal.status, refusal.body, { 'x-webui-auth': refusal.reason })
}

export function json(response: ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) {
  const data = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers })
  response.end(data)
}

function text(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

const PHASE_TEXT: Record<InstancePhase, string> = {
  stopped: '已停止',
  starting: '正在启动',
  running: '正在启动',
  stopping: '正在停止',
  failed: '启动失败',
}

function unavailable(response: ServerResponse, target: GatewayTarget, path: string) {
  const state = PHASE_TEXT[target.phase]
  if (path.startsWith('/api/')) {
    json(response, 503, { success: false, message: `实例 ${target.name} ${state}`, data: { instance: target.name, phase: target.phase } })
    return
  }
  // A page: shown while it starts, and reloaded until it is up
  const waiting = target.phase === 'starting' || target.phase === 'running'
  const name = escapeHtml(target.name)
  response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...waiting ? { refresh: '2' } : {} })
  response.end(`<!doctype html><meta charset="utf-8"><title>LuckyLillia</title>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#555">
<div style="text-align:center"><h2>实例 ${name} ${state}</h2>
<p>${waiting ? '页面会在实例启动后自动打开' : '请在实例管理中启动它'}</p>
<p style="margin-top:16px"><a href="/" style="color:#ec4899;text-decoration:none;font-weight:500">返回实例管理</a></p></div></body>`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function readBody(request: IncomingMessage, limit = MAX_JSON_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

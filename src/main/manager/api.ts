import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { INVALID_INSTANCE_NAME, isValidInstanceName } from '@/common/instanceName'
import { isDockerEnvironment } from '@/common/utils/environment'
import { json, readBody } from './gateway'
import type { InstancePhase, InstanceStatus } from './instance'
import { Registry, RegistryError } from './registry'

export interface GatewayLock {
  path: 'webui.host' | 'webui.port'
  by: string
}

export interface GatewayState {
  host: string
  port: number
  listening: number
  envLocked: GatewayLock[]
}

export interface ManagedInstanceInfo extends InstanceStatus {
  autostart: boolean
  isDefault: boolean
}

export interface InstanceHandle {
  status(): InstanceStatus
  recentOutput(): string[]
  start(): void
  stop(): Promise<void>
  restart(): Promise<void>
}

export interface ManagerApiOptions {
  registry: Registry
  selected(): string
  statusOf(name: string): InstanceStatus
  recentOutput(name: string): string[]
  instance(name: string): InstanceHandle
  /** True when some unmanaged process (e.g. --no-manager) holds this instance's lock */
  isLockedExternal?(name: string): Promise<boolean>
  onRenamed?(from: string, to: string): void
  onRemoved?(name: string): void
  gatewayState(): GatewayState
  /** Called after the HTTP response is sent when host or port changed */
  onGatewayChanged?(host: string, port: number): void
}

const INSTANCE_ACTION = /^\/api\/manager\/instances\/([^/]+)\/(start|stop|restart)$/
const INSTANCE_LOGS = /^\/api\/manager\/instances\/([^/]+)\/logs$/
const INSTANCE_ITEM = /^\/api\/manager\/instances\/([^/]+)$/

function isActive(phase: InstancePhase): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'stopping'
}

function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await readBody(request)
  } catch (error) {
    json(response, 413, { success: false, message: (error as Error).message })
    return undefined
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(response, 400, { success: false, message: '请求格式不对' })
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch {
    json(response, 400, { success: false, message: '请求格式不对' })
    return undefined
  }
}

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof RegistryError) {
    json(response, error.status, { success: false, message: error.message })
    return
  }
  json(response, 500, { success: false, message: error instanceof Error ? error.message : String(error) })
}

export function createManagerApi(options: ManagerApiOptions) {
  const { registry } = options
  const infoOf = (name: string): ManagedInstanceInfo => ({
    ...options.statusOf(name),
    autostart: registry.settings(name).autostart,
    isDefault: name === registry.defaultInstance(),
  })

  return async (request: IncomingMessage, response: ServerResponse, route: string): Promise<boolean> => {
    const method = request.method ?? 'GET'

    // GET /api/manager/instances
    if (route === '/api/manager/instances' && method === 'GET') {
      json(response, 200, {
        success: true,
        data: {
          selected: options.selected(),
          instances: registry.list().map(infoOf),
        },
      })
      return true
    }

    // POST /api/manager/instances
    if (route === '/api/manager/instances' && method === 'POST') {
      const body = await readJson(request, response)
      if (!body) return true
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) {
        json(response, 400, { success: false, message: '实例名不能为空' })
        return true
      }
      try {
        registry.create(name, { autostart: body.autostart === true })
      } catch (error) {
        respondError(response, error)
        return true
      }
      if (body.start === true) options.instance(name).start()
      json(response, 200, { success: true, data: infoOf(name) })
      return true
    }

    // POST /api/manager/instances/:name/(start|stop|restart)
    const actionMatch = INSTANCE_ACTION.exec(route)
    if (actionMatch && method === 'POST') {
      const name = decodeSegment(actionMatch[1])
      if (!name || !registry.exists(name)) {
        json(response, 404, { success: false, message: `没有实例 ${name ?? actionMatch[1]}` })
        return true
      }
      const child = options.instance(name)
      if (actionMatch[2] === 'start') child.start()
      else if (actionMatch[2] === 'stop') await child.stop()
      else await child.restart()
      json(response, 200, { success: true, data: infoOf(name) })
      return true
    }

    // GET /api/manager/instances/:name/logs
    const logsMatch = INSTANCE_LOGS.exec(route)
    if (logsMatch && method === 'GET') {
      const name = decodeSegment(logsMatch[1])
      if (!name || !registry.exists(name)) {
        json(response, 404, { success: false, message: `没有实例 ${name ?? logsMatch[1]}` })
        return true
      }
      json(response, 200, {
        success: true,
        data: { name, lines: options.recentOutput(name) },
      })
      return true
    }

    // PATCH / DELETE /api/manager/instances/:name
    const itemMatch = INSTANCE_ITEM.exec(route)
    if (itemMatch && (method === 'PATCH' || method === 'DELETE')) {
      const name = decodeSegment(itemMatch[1])
      if (!name || !registry.exists(name)) {
        json(response, 404, { success: false, message: `没有实例 ${name ?? itemMatch[1]}` })
        return true
      }

      if (method === 'DELETE') {
        if (await options.isLockedExternal?.(name)) {
          json(response, 409, { success: false, message: '实例正在其他进程中运行，请先停止后再删除' })
          return true
        }
        if (isActive(options.statusOf(name).phase)) {
          await options.instance(name).stop()
        }
        try {
          registry.remove(name)
          options.onRemoved?.(name)
        } catch (error) {
          respondError(response, error)
          return true
        }
        json(response, 200, { success: true })
        return true
      }

      // PATCH
      const body = await readJson(request, response)
      if (!body) return true
      let currentName = name
      if (body.renameTo !== undefined) {
        if (typeof body.renameTo !== 'string') {
          json(response, 400, { success: false, message: '新实例名格式不对' })
          return true
        }
        const nextName = body.renameTo.trim()
        if (!isValidInstanceName(nextName)) {
          json(response, 400, { success: false, message: INVALID_INSTANCE_NAME })
          return true
        }
        if (nextName !== name) {
          if (registry.exists(nextName)) {
            json(response, 409, { success: false, message: `实例 ${nextName} 已存在` })
            return true
          }
          if (await options.isLockedExternal?.(name)) {
            json(response, 409, { success: false, message: '实例正在其他进程中运行，请先停止后再重命名' })
            return true
          }
          const phase = options.statusOf(name).phase
          const wasActive = isActive(phase)
          const shouldRestart = phase === 'running' || phase === 'starting'
          if (wasActive) {
            await options.instance(name).stop()
          }
          try {
            registry.rename(name, nextName)
            options.onRenamed?.(name, nextName)
          } catch (error) {
            if (shouldRestart) options.instance(name).start()
            respondError(response, error)
            return true
          }
          currentName = nextName
          if (shouldRestart) {
            options.instance(currentName).start()
          }
        }
      }
      if (body.autostart !== undefined) {
        if (typeof body.autostart !== 'boolean') {
          json(response, 400, { success: false, message: 'autostart 必须是布尔值' })
          return true
        }
        registry.setAutostart(currentName, body.autostart)
      }
      json(response, 200, { success: true, data: infoOf(currentName) })
      return true
    }

    // GET /api/manager/gateway
    if (route === '/api/manager/gateway' && method === 'GET') {
      json(response, 200, { success: true, data: options.gatewayState() })
      return true
    }

    // PATCH / POST /api/manager/gateway
    if (route === '/api/manager/gateway' && (method === 'PATCH' || method === 'POST')) {
      const body = await readJson(request, response)
      if (!body) return true
      const before = options.gatewayState()
      const locked = new Set(before.envLocked.map(item => item.path))
      const patch: { host?: string; port?: number } = {}
      if (body.host !== undefined && !locked.has('webui.host')) {
        if (typeof body.host !== 'string') {
          json(response, 400, { success: false, message: '监听地址格式不正确' })
          return true
        }
        patch.host = body.host.trim()
      }
      if (body.port !== undefined && !locked.has('webui.port')) {
        if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
          json(response, 400, { success: false, message: '端口必须是 1 到 65535 之间的整数' })
          return true
        }
        patch.port = body.port
      }
      try {
        if (patch.host !== undefined || patch.port !== undefined) registry.setGateway(patch)
      } catch (error) {
        respondError(response, error)
        return true
      }
      const after = options.gatewayState()
      const changed = after.host !== before.host || after.port !== before.port
      json(response, 200, { success: true, data: { ...after, restarted: changed } })
      if (changed) {
        setTimeout(() => options.onGatewayChanged?.(after.host, after.port), 150)
      }
      return true
    }

    // GET /api/manager/network-interfaces
    if (route === '/api/manager/network-interfaces' && method === 'GET') {
      const isDocker = isDockerEnvironment()
      const addresses: string[] = []
      if (!isDocker) {
        const interfaces = networkInterfaces()
        for (const name of Object.keys(interfaces)) {
          for (const iface of interfaces[name] ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address)
          }
        }
      }
      json(response, 200, { success: true, data: addresses, isDocker })
      return true
    }

    return false
  }
}

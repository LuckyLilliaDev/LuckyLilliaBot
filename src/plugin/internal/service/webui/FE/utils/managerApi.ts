import { apiFetch, ApiError, authorizedFetch } from './api'

export type InstancePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface ManagedInstance {
  name: string
  phase: InstancePhase
  pid?: number
  webuiPort?: number
  exitCode?: number | null
  error?: string
  startedAt?: number
  autostart: boolean
  isDefault: boolean
}

export interface ManagerInstancesPayload {
  selected: string
  instances: ManagedInstance[]
}

export interface GatewayLock {
  path: 'webui.host' | 'webui.port'
  by: string
}

export interface GatewaySettings {
  host: string
  port: number
  listening: number
  envLocked: GatewayLock[]
  restarted?: boolean
}

const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidInstanceName(name: string): boolean {
  return INSTANCE_NAME_RE.test(name)
}

/**
 * Checks whether the WebUI is served behind the instance manager. Uses authorizedFetch so the unified
 * login prompt still runs first; returns null when standalone (--no-manager / --no-supervisor) answers 404.
 */
export async function probeManagerInstances(): Promise<ManagerInstancesPayload | null> {
  const response = await authorizedFetch('/api/manager/instances')
  if (response.status === 404) return null
  if (!response.ok) {
    let message = `HTTP error! status: ${response.status}`
    try {
      const payload = await response.json()
      message = payload.message || message
    } catch {
      // ignore non-JSON body
    }
    throw new ApiError(message, response.status)
  }
  const body = await response.json()
  if (!body?.success || !body.data) throw new Error(body?.message || '获取实例列表失败')
  return body.data as ManagerInstancesPayload
}

export async function listManagedInstances(): Promise<ManagerInstancesPayload> {
  const res = await apiFetch<ManagerInstancesPayload>('/api/manager/instances')
  if (!res.success) throw new Error(res.message || '获取实例列表失败')
  return res.data
}

export async function createInstance(input: { name: string; autostart?: boolean; start?: boolean }): Promise<ManagedInstance> {
  const res = await apiFetch<ManagedInstance>('/api/manager/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.success) throw new Error(res.message || '创建实例失败')
  return res.data
}

export async function startInstance(name: string): Promise<ManagedInstance> {
  const res = await apiFetch<ManagedInstance>(`/api/manager/instances/${encodeURIComponent(name)}/start`, { method: 'POST' })
  if (!res.success) throw new Error(res.message || '启动实例失败')
  return res.data
}

export async function stopInstance(name: string): Promise<ManagedInstance> {
  const res = await apiFetch<ManagedInstance>(`/api/manager/instances/${encodeURIComponent(name)}/stop`, { method: 'POST' })
  if (!res.success) throw new Error(res.message || '停止实例失败')
  return res.data
}

export async function restartInstance(name: string): Promise<ManagedInstance> {
  const res = await apiFetch<ManagedInstance>(`/api/manager/instances/${encodeURIComponent(name)}/restart`, { method: 'POST' })
  if (!res.success) throw new Error(res.message || '重启实例失败')
  return res.data
}

export async function patchInstance(name: string, patch: { autostart?: boolean; renameTo?: string }): Promise<ManagedInstance> {
  const res = await apiFetch<ManagedInstance>(`/api/manager/instances/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.success) throw new Error(res.message || '更新实例失败')
  return res.data
}

export async function deleteInstance(name: string): Promise<void> {
  const res = await apiFetch<null>(`/api/manager/instances/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.success) throw new Error(res.message || '删除实例失败')
}

export async function getInstanceLogs(name: string): Promise<{ name: string; lines: string[] }> {
  const res = await apiFetch<{ name: string; lines: string[] }>(`/api/manager/instances/${encodeURIComponent(name)}/logs`)
  if (!res.success) throw new Error(res.message || '获取实例日志失败')
  return res.data
}

export async function getGatewaySettings(): Promise<GatewaySettings> {
  const res = await apiFetch<GatewaySettings>('/api/manager/gateway')
  if (!res.success) throw new Error(res.message || '获取网关设置失败')
  return res.data
}

export async function saveGatewaySettings(patch: { host?: string; port?: number }): Promise<GatewaySettings> {
  const res = await apiFetch<GatewaySettings>('/api/manager/gateway', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.success) throw new Error(res.message || '保存网关设置失败')
  return res.data
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { isValidInstanceName } from '@/common/instanceName'
import { CoreUpdateError, type CoreUpdater } from '../coreUpdate'
import { Registries } from '@/plugin/internal/tool/market/registry'
import { MarketSchema, registriesOf, type MarketSettings } from '@/plugin/internal/tool/market/settings'
import { json, readBody } from './gateway'

const RESUME_FILE = 'resume-instances.json'

/** Reads custom npm registries configured on `builtin:market` in the selected or default instance, if any */
export function managerRegistries(instancesDir: string, preferred: string[]): Registries {
  for (const name of [...new Set(preferred)]) {
    const file = path.join(instancesDir, name, 'plugins.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        entries?: Array<{ id?: string; name?: string; config?: MarketSettings }>
      }
      const entry = parsed?.entries?.find(item => item?.id === 'builtin:market' || item?.name === 'builtin:market')
      if (entry?.config) {
        const settings = new MarketSchema(entry.config)
        return new Registries(registriesOf(settings))
      }
    } catch {
      // Ignore invalid JSON and try next instance or defaults
    }
  }
  return new Registries(registriesOf(new MarketSchema(undefined)))
}

/** Saves the instances running before a core-update restart so the new manager brings them right back */
export function saveResumeInstances(stateDir: string, names: string[]): void {
  const valid = [...new Set(names)].filter(isValidInstanceName)
  if (!valid.length) return
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, RESUME_FILE), JSON.stringify(valid))
  } catch {
    // Non-fatal: autostart still starts configured instances
  }
}

/** Reads and deletes the one-shot resume list written before a core-update restart */
export function consumeResumeInstances(stateDir: string): string[] {
  const file = path.join(stateDir, RESUME_FILE)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && isValidInstanceName(v)) : []
  } catch {
    return []
  } finally {
    rmSync(file, { force: true })
  }
}

/** Serves `/api/core-update/*` directly from the manager gateway with the same contract as coreUpdate.ts */
export function createCoreUpdateHandler(updater: CoreUpdater) {
  const respond = async (response: ServerResponse, task: () => Promise<unknown>) => {
    try {
      json(response, 200, { success: true, data: await task() })
    } catch (error) {
      const status = error instanceof CoreUpdateError ? error.status : 500
      json(response, status, { success: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    route: string,
    query: URLSearchParams,
  ): Promise<boolean> => {
    const method = request.method ?? 'GET'
    if (route === '/api/core-update/status' && method === 'GET') {
      await respond(response, async () => updater.status())
      return true
    }
    if (route === '/api/core-update/check' && method === 'POST') {
      await respond(response, () => updater.check())
      return true
    }
    if (route === '/api/core-update/update' && method === 'POST') {
      let version = ''
      try {
        const raw = await readBody(request)
        if (raw.trim()) {
          const body = JSON.parse(raw) as { version?: unknown }
          version = String(body?.version ?? '')
        }
      } catch {
        json(response, 400, { success: false, message: '请求格式不对' })
        return true
      }
      await respond(response, () => updater.update(version))
      return true
    }
    if (route === '/api/core-update/release-notes' && method === 'GET') {
      const version = query.get('version') ?? updater.status().latest ?? ''
      await respond(response, () => updater.releaseNotes(version))
      return true
    }
    return false
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_INSTANCE, INVALID_INSTANCE_NAME, isValidInstanceName } from '@/common/instanceName'

export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 3080

export interface InstanceSettings {
  /** Started with the manager */
  autostart: boolean
}

/** data/manager.json: what the manager keeps of its own; each instance's settings stay in its directory */
export interface ManagerConfig {
  gateway: { host: string; port: number }
  /** Preferred default instance; `null` when all instances have been deleted */
  defaultInstance: string | null
  instances: Record<string, InstanceSettings>
}

export interface RegistryLog {
  info(message: string): void
  warn(message: string): void
}

/**
 * The instances of a data directory and the manager's settings. An instance is a directory under
 * data/instances/; data/manager.json only adds what the manager needs to know about it.
 */
export class Registry {
  readonly file: string
  readonly instancesDir: string
  private config?: ManagerConfig

  constructor(readonly dataDir: string, private readonly log: RegistryLog) {
    this.file = path.join(dataDir, 'manager.json')
    this.instancesDir = path.join(dataDir, 'instances')
  }

  /**
   * Reads data/manager.json, writing it on the first start: the gateway takes the address the default instance's
   * WebUI had, so the WebUI keeps its URL. On a brand-new directory with no instances yet, seeds `default`.
   */
  load(): ManagerConfig {
    if (this.config) return this.config
    let saved: Partial<ManagerConfig> | undefined
    const hasFile = existsSync(this.file)
    if (hasFile) {
      try {
        saved = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch (error) {
        // Kept as it is for a fix by hand: the defaults run this time
        this.log.warn(`${this.file} 不是有效的 JSON，本次使用默认设置：${(error as Error).message}`)
        const disk = this.diskInstances()
        this.config = normalize(undefined, disk, this.legacyGateway())
        return this.config
      }
    }
    let disk = this.diskInstances()
    if (!hasFile && disk.length === 0) {
      mkdirSync(path.join(this.instancesDir, DEFAULT_INSTANCE), { recursive: true })
      disk = [DEFAULT_INSTANCE]
    }
    this.config = normalize(saved, disk, saved ? undefined : this.legacyGateway())
    if (!hasFile) {
      this.save()
      this.log.info(`已创建 ${this.file}，WebUI 地址 ${this.config.gateway.host || '0.0.0.0'}:${this.config.gateway.port}`)
    }
    return this.config
  }

  save(): void {
    const config = this.load()
    mkdirSync(this.dataDir, { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n')
    try {
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  /** The default instance name if at least one instance exists, else undefined */
  defaultInstance(): string | undefined {
    const config = this.load()
    const disk = this.diskInstances()
    if (config.defaultInstance && disk.includes(config.defaultInstance)) return config.defaultInstance
    return disk[0]
  }

  /** Every instance directory on disk: the default instance first, then the rest in name order */
  list(): string[] {
    const config = this.load()
    const names = this.diskInstances()
    const primary = config.defaultInstance
    if (primary && names.includes(primary)) {
      return [primary, ...names.filter(name => name !== primary)]
    }
    return names
  }

  exists(name: string): boolean {
    if (!isValidInstanceName(name)) return false
    this.load()
    return existsSync(path.join(this.instancesDir, name))
  }

  settings(name: string): InstanceSettings {
    return this.load().instances[name] ?? { autostart: false }
  }

  /** The instances to start with the manager */
  autostart(): string[] {
    const known = new Set(this.list())
    return Object.entries(this.load().instances)
      .filter(([name, settings]) => settings.autostart && known.has(name))
      .map(([name]) => name)
  }

  setAutostart(name: string, autostart: boolean): void {
    const config = this.load()
    config.instances[name] = { ...config.instances[name], autostart }
    this.save()
  }

  create(name: string, options: { autostart?: boolean } = {}): void {
    if (!isValidInstanceName(name)) throw new RegistryError(400, INVALID_INSTANCE_NAME)
    if (this.exists(name)) throw new RegistryError(409, `实例 ${name} 已存在`)
    mkdirSync(path.join(this.instancesDir, name), { recursive: true })
    const config = this.load()
    config.instances[name] = { autostart: options.autostart === true }
    if (!config.defaultInstance || !existsSync(path.join(this.instancesDir, config.defaultInstance))) {
      config.defaultInstance = name
    }
    this.save()
  }

  rename(from: string, to: string): void {
    if (!isValidInstanceName(from) || !isValidInstanceName(to)) throw new RegistryError(400, INVALID_INSTANCE_NAME)
    if (!this.exists(from)) throw new RegistryError(404, `没有实例 ${from}`)
    if (from === to) return
    if (this.exists(to)) throw new RegistryError(409, `实例 ${to} 已存在`)
    renameSync(path.join(this.instancesDir, from), path.join(this.instancesDir, to))
    this.cleanStateFiles(from)
    const config = this.load()
    let dirty = false
    const current = config.instances[from]
    if (current) {
      config.instances[to] = current
      delete config.instances[from]
      dirty = true
    }
    if (config.defaultInstance === from) {
      config.defaultInstance = to
      dirty = true
    }
    if (dirty) this.save()
  }

  remove(name: string): void {
    if (!isValidInstanceName(name)) throw new RegistryError(400, INVALID_INSTANCE_NAME)
    if (!this.exists(name)) throw new RegistryError(404, `没有实例 ${name}`)
    rmSync(path.join(this.instancesDir, name), { recursive: true, force: true })
    this.cleanStateFiles(name)
    const config = this.load()
    let dirty = false
    if (name in config.instances) {
      delete config.instances[name]
      dirty = true
    }
    if (config.defaultInstance === name) {
      config.defaultInstance = this.diskInstances()[0] ?? null
      dirty = true
    }
    if (dirty) this.save()
  }

  setGateway(patch: Partial<ManagerConfig['gateway']>): ManagerConfig['gateway'] {
    const config = this.load()
    if (patch.host !== undefined) {
      if (typeof patch.host !== 'string') throw new RegistryError(400, '监听地址格式不正确')
      config.gateway.host = patch.host.trim()
    }
    if (patch.port !== undefined) {
      if (!isPort(patch.port)) throw new RegistryError(400, '端口必须是 1 到 65535 之间的整数')
      config.gateway.port = patch.port
    }
    this.save()
    return { ...config.gateway }
  }

  private diskInstances(): string[] {
    try {
      return readdirSync(this.instancesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && isValidInstanceName(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  private cleanStateFiles(name: string): void {
    const stateDir = path.join(this.dataDir, 'state', 'instances')
    rmSync(path.join(stateDir, `${name}.json`), { force: true })
    rmSync(path.join(stateDir, `${name}.sock`), { force: true })
  }

  /** The address the default instance's WebUI had before the manager, if it had its own settings for it */
  private legacyGateway(): Partial<ManagerConfig['gateway']> | undefined {
    try {
      const settings = JSON.parse(readFileSync(path.join(this.instancesDir, DEFAULT_INSTANCE, 'settings.json'), 'utf8'))
      const webui = settings?.webui
      if (!webui || typeof webui !== 'object') return
      return {
        ...typeof webui.host === 'string' ? { host: webui.host } : {},
        ...isPort(webui.port) ? { port: webui.port } : {},
      }
    } catch {
      return undefined
    }
  }
}

export class RegistryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535
}

function normalize(
  saved: Partial<ManagerConfig> | undefined,
  disk: string[],
  legacy?: Partial<ManagerConfig['gateway']>,
): ManagerConfig {
  const gateway = saved?.gateway && typeof saved.gateway === 'object' ? saved.gateway : legacy ?? {}
  const instances: Record<string, InstanceSettings> = {}
  if (saved?.instances && typeof saved.instances === 'object') {
    for (const [name, settings] of Object.entries(saved.instances)) {
      if (!isValidInstanceName(name) || !settings || typeof settings !== 'object') continue
      instances[name] = { autostart: settings.autostart === true }
    }
  } else {
    const initial = disk.includes(DEFAULT_INSTANCE) ? DEFAULT_INSTANCE : disk[0]
    if (initial) instances[initial] = { autostart: true }
  }

  let defaultInstance: string | null
  if (saved && 'defaultInstance' in saved) {
    defaultInstance = typeof saved.defaultInstance === 'string' && isValidInstanceName(saved.defaultInstance)
      ? saved.defaultInstance
      : null
  } else {
    defaultInstance = disk.includes(DEFAULT_INSTANCE)
      ? DEFAULT_INSTANCE
      : disk[0] ?? (DEFAULT_INSTANCE in instances ? DEFAULT_INSTANCE : null)
  }

  return {
    gateway: {
      host: typeof gateway.host === 'string' ? gateway.host : DEFAULT_GATEWAY_HOST,
      port: isPort(gateway.port) ? gateway.port : DEFAULT_GATEWAY_PORT,
    },
    defaultInstance,
    instances,
  }
}

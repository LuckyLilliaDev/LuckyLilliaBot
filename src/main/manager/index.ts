/**
 * llbot-manager.js: runs every instance of this data directory as a child (llbot-core.js --instance <name>) and
 * serves their WebUIs on one address with one login. llbot.js, the supervisor every launcher runs, starts this and
 * starts it again when it asks for a restart.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { configPaths } from '@/common/configPaths'
import { DATA_DIR, LOG_DIR, STATE_DIR } from '@/common/globalVars'
import { resolveInstance } from '@/common/instance'
import { migrateToInstances, migrateWebuiToken } from '../config/migrate'
import { CoreUpdater, installDirOf, scheduleAutoCheck, updateBlocker } from '../coreUpdate'
import { lockManager, runningInstances } from '../instanceLock'
import { isSupervised, parentPidOf, RESTART_EXIT_CODE } from '../restart'
import { createManagerApi, type GatewayLock, type GatewayState } from './api'
import { splitArgs } from './args'
import { GatewayAuth } from './auth'
import { consumeResumeInstances, createCoreUpdateHandler, managerRegistries, saveResumeInstances } from './coreUpdateHandler'
import { Gateway } from './gateway'
import { InstanceProcess, type InstanceStatus } from './instance'
import { PackageCoordinator } from './packageCoordinator'
import { Registry } from './registry'

const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const log = {
  info: (message: string) => console.log(`${time()} [manager] ${message}`),
  warn: (message: string) => console.warn(`${time()} [manager] ${message}`),
  error: (message: string) => console.error(`${time()} [manager] ${message}`),
}

/** llbot-core.js next to this bundle; the source entry when run from the source tree with tsx */
function coreEntry(): string {
  const bundled = path.join(import.meta.dirname, 'llbot-core.js')
  return existsSync(bundled) ? bundled : path.join(import.meta.dirname, '..', 'main.ts')
}

/** Built WebUI assets next to this bundle, or in dist/webui when run from the source tree */
function webuiDistDir(): string | undefined {
  for (const candidate of [
    path.join(import.meta.dirname, 'webui'),
    path.join(import.meta.dirname, '../../../dist/webui'),
  ]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

function displayUrl(host: string, port: number): string {
  const shown = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${shown}:${port}/`
}

async function main() {
  const argv = process.argv.slice(2)
  const args = splitArgs(argv)

  let release: () => void
  try {
    release = await lockManager()
  } catch (error) {
    log.error((error as Error).message)
    process.exit(1)
  }
  for (const dir of [LOG_DIR]) mkdirSync(dir, { recursive: true })
  // Before the instances are listed: may make them, from the files of versions before instances
  migrateToInstances({ info: (...parts) => log.info(parts.join(' ')), warn: (...parts) => log.warn(parts.join(' ')) })

  const registry = new Registry(DATA_DIR, log)
  registry.load()
  let explicitTarget: string | undefined
  try {
    const choice = resolveInstance(argv, process.env)
    if (choice.reason !== '默认实例') explicitTarget = choice.name
  } catch (error) {
    log.error((error as Error).message)
    process.exit(1)
  }
  let target: string | undefined = explicitTarget ?? registry.defaultInstance()

  const secret = randomBytes(32).toString('hex')
  const core = coreEntry()
  const instances = new Map<string, InstanceProcess>()
  const running = () => [...instances.values()].filter(instance => instance.running).length
  const statusOf = (name: string): InstanceStatus => instances.get(name)?.status() ?? { name, phase: 'stopped' }

  const coordinator = new PackageCoordinator({
    send: (name, message) => instances.get(name)?.sendMessage(message) ?? false,
    pidOf: name => instances.get(name)?.status().pid,
  })

  const instance = (name: string): InstanceProcess => {
    let existing = instances.get(name)
    if (existing) return existing
    existing = new InstanceProcess(name, {
      core,
      // What only one account's launch means (--ntqq-account, --plugin, ...) is for the instance the launch named
      args: () => (name === target ? [...args.shared, ...args.target] : args.shared),
      secret,
      output: (from, line, stream) => {
        // Prefixed once there is more than one: a QR code keeps its shape, the prefix being the same on each line
        const out = running() > 1 ? `[${from}] ${line}` : line
        ;(stream === 'stderr' ? process.stderr : process.stdout).write(out + '\n')
      },
      onChange: (status) => {
        if (status.phase === 'running') log.info(`实例 ${name} 已就绪`)
        else if (status.phase === 'stopped') log.info(`实例 ${name} 已停止`)
      },
      onMessage: (from, message) => coordinator.onMessage(from, message),
      onExit: (from) => coordinator.onExit(from),
      log: log.info,
    })
    instances.set(name, existing)
    return existing
  }

  migrateWebuiToken({ info: (...parts) => log.info(parts.join(' ')), warn: (...parts) => log.warn(parts.join(' ')) }, target)
  const auth = new GatewayAuth({
    file: configPaths.webuiToken(),
    accessLog: path.join(LOG_DIR, 'webui_access.log'),
    log,
  })

  // What launched this may fix the address (the desktop app passes the port it picked); the file has the rest
  const envHost = process.env.LLBOT_WEBUI_HOST
  const rawEnvPort = Number(process.env.LLBOT_WEBUI_PORT)
  const envPort = Number.isInteger(rawEnvPort) && rawEnvPort > 0 && rawEnvPort <= 65535 ? rawEnvPort : undefined
  const envLocked: GatewayLock[] = [
    ...envHost !== undefined ? [{ path: 'webui.host' as const, by: 'LLBOT_WEBUI_HOST' }] : [],
    ...args.webuiPort !== undefined
      ? [{ path: 'webui.port' as const, by: '--webui-port' }]
      : envPort !== undefined ? [{ path: 'webui.port' as const, by: 'LLBOT_WEBUI_PORT' }] : [],
  ]
  const effectiveHost = () => envHost ?? registry.load().gateway.host
  const effectivePort = () => args.webuiPort ?? envPort ?? registry.load().gateway.port

  let listening = effectivePort()
  let boundHost = effectiveHost()
  let rebinding: Promise<void> = Promise.resolve()

  const gatewayState = (): GatewayState => ({
    host: effectiveHost(),
    port: effectivePort(),
    listening,
    envLocked,
  })

  const managedRunningNames = () => [...instances.values()]
    .filter(child => child.running)
    .map(child => child.name)

  let stopping = false
  let stopAutoCheck: (() => void) | undefined
  let stoppedForUpdate: string[] = []

  const shutdown = async (code = 0) => {
    if (stopping) {
      // A second Ctrl+C: down now
      for (const child of instances.values()) void child.stop(0)
      process.exit(code)
    }
    stopping = true
    stopAutoCheck?.()
    if (running()) log.info('正在停止所有实例')
    // The desktop app waits 35 seconds before it kills the whole tree
    await Promise.allSettled([...instances.values()].map(child => child.stop(25_000)))
    await gateway.close().catch(() => {})
    release()
    process.exit(code)
  }

  const installDir = installDirOf(import.meta.dirname)
  const updater = new CoreUpdater({
    installDir,
    registry: () => managerRegistries(registry.instancesDir, [target, registry.defaultInstance()].filter((x): x is string => Boolean(x))),
    blocker: () => updateBlocker(installDir, {
      supervised: isSupervised(),
      ignoreInstances: managedRunningNames(),
    }),
    beforeReplace: async () => {
      stoppedForUpdate = managedRunningNames()
      if (stoppedForUpdate.length) {
        log.info(`正在停止所有实例以安装更新：${stoppedForUpdate.join('、')}`)
        await Promise.allSettled(stoppedForUpdate.map(name => instances.get(name)?.stop(25_000)))
      }
    },
    onReplaceFailed: async () => {
      for (const name of stoppedForUpdate) {
        if (registry.exists(name)) instance(name).start()
      }
      stoppedForUpdate = []
    },
    restart: () => {
      if (!isSupervised()) return false
      saveResumeInstances(STATE_DIR, stoppedForUpdate)
      void shutdown(RESTART_EXIT_CODE)
      return true
    },
    log,
  })

  const manager = createManagerApi({
    registry,
    selected: () => target ?? registry.defaultInstance() ?? '',
    statusOf,
    recentOutput: (name) => instances.get(name)?.recentOutput() ?? [],
    instance,
    isLockedExternal: async (name) => !instances.get(name)?.running && (await runningInstances()).includes(name),
    onRenamed: (from, to) => {
      instances.delete(from)
      if (target === from) target = to
    },
    onRemoved: (name) => {
      instances.delete(name)
      if (target === name) target = registry.defaultInstance()
    },
    gatewayState,
    onGatewayChanged: (nextHost, nextPort) => {
      rebinding = rebinding.then(async () => {
        const previousHost = boundHost
        const previousPort = listening
        try {
          listening = await gateway.rebind(nextHost, nextPort)
          boundHost = nextHost
          log.info(`Webui 服务器已重启 ${nextHost || '0.0.0.0'}:${listening}`)
          log.info(`所有实例共用这个 WebUI 地址：${displayUrl(nextHost, listening)}`)
        } catch (error) {
          log.error(`WebUI 无法改到 ${nextHost || '0.0.0.0'}:${nextPort}：${(error as Error).message}，恢复原监听地址`)
          try {
            listening = await gateway.rebind(previousHost, previousPort)
            boundHost = previousHost
          } catch (recoverError) {
            log.error(`恢复原监听地址失败：${(recoverError as Error).message}`)
          }
        }
      })
    },
  })

  const gateway = new Gateway({
    auth,
    secret,
    lookup: (name) => {
      if (!instances.has(name) && !registry.exists(name)) return undefined
      const status = statusOf(name)
      return { name, phase: status.phase, port: status.webuiPort }
    },
    defaultInstance: () => target ?? registry.defaultInstance() ?? '',
    manager,
    coreUpdate: createCoreUpdateHandler(updater),
    webuiDir: webuiDistDir(),
    log,
  })

  try {
    listening = await gateway.listen(boundHost, effectivePort())
  } catch (error) {
    log.error(`WebUI 无法监听 ${boundHost || '0.0.0.0'}:${effectivePort()}：${(error as Error).message}`)
    release()
    process.exit(1)
  }
  // Launchers and scripts read the address from this line
  log.info(`Webui 服务器已启动 ${boundHost || '0.0.0.0'}:${listening}`)
  log.info(`所有实例共用这个 WebUI 地址：${displayUrl(boundHost, listening)}`)

  updater.cleanup().catch(error => log.warn(error instanceof Error ? error.message : String(error)))
  stopAutoCheck = scheduleAutoCheck(updater, { log })

  const resumed = consumeResumeInstances(STATE_DIR).filter(name => registry.exists(name))
  const autostart = [...new Set([...(explicitTarget ? [explicitTarget] : []), ...registry.autostart(), ...resumed])]
  for (const name of autostart) instance(name).start()
  if (autostart.length === 0) {
    log.info(registry.list().length === 0
      ? '当前还没有实例，请在 WebUI 的「实例管理」中新建实例'
      : '没有设为自启的实例，可在 WebUI 的「实例管理」中手动启动')
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  if (process.platform !== 'win32') process.on('SIGHUP', () => void shutdown())

  const parent = parentPidOf(argv)
  if (!Number.isNaN(parent) && parent !== process.pid) {
    const timer = setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
        clearInterval(timer)
        void shutdown()
      }
    }, 1000)
    timer.unref()
  }
}

main().catch((error) => {
  log.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})

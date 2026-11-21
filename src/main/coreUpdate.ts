import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { compareVersions } from 'compare-versions'
import type { Context } from 'cordis'
import { Hono, type Context as HonoContext } from 'hono'
import { version as runningVersion } from '../version'
import { canRestart, requestRestart } from './hostLifecycle'
import { currentInstance } from '@/common/instance'
import { runningInstances } from './instanceLock'
import { FAILED_RUNTIME_DIR_NAME, inContainer, RELEASE_NAMES, runtimeDir, RUNTIME_DIR_NAME, selfUpdateDisabled } from './runtime'
import { isExactVersion, matches, Registries, RegistryError, type PackageVersion, type RegistryClient } from '../plugin/internal/tool/market/registry'
import { MarketSchema, registriesOf, type MarketSettings } from '../plugin/internal/tool/market/settings'
import { extractPackage } from '../plugin/internal/tool/market/tar'

const gunzipAsync = promisify(gunzip)

/** The npm package releases of the bot itself are published as */
export const CORE_PACKAGE = '@luckylillia-dev/luckylillia'
/** Inside the installation: staged downloads and the files the last update replaced */
export const WORK_DIR = '.llbot-update'
/** Never replaced, whatever a package carries: the user's data, and this updater's own work */
const PROTECTED = new Set(['data', WORK_DIR])
const MAX_TAR = 1024 * 1024 * 1024

export class CoreUpdateError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message)
  }
}

export interface CoreUpdateStatus {
  current: string
  /** The newest published version, once checked */
  latest?: string
  /** `latest` is newer than the running version and fits this installation */
  available: boolean
  /** Why this installation cannot update itself at all, e.g. it runs from the source tree */
  blocked?: string
  /** Why `latest` cannot be installed here, e.g. it needs a newer Node.js */
  incompatible?: string
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting'
  /** What went wrong with the last check or update */
  error?: string
  checkedAt?: number
}

export interface CoreUpdaterOptions {
  /** Where llbot.js and llbot-core.js are */
  installDir: string
  current?: string
  registry: () => RegistryClient
  /** Why it cannot update itself right now, if it cannot */
  blocker?: () => Promise<string | undefined>
  /** Shuts down and has the supervisor start the new version; false when nothing would start it again */
  restart?: () => boolean
  log?: { info(message: string): void; warn(message: string): void }
  /** Before restarting, so the answer to the update request reaches the browser */
  restartDelay?: number
  nodeVersion?: string
  /** In a container the release goes to the data volume (runtime.ts) instead of replacing the program's files */
  container?: boolean
  /** Where data/ is, the working directory by default */
  cwd?: string
}

/**
 * Updates the installation the bot runs from to the newest release on npm, then restarts into it. Only the
 * entries the package carries are replaced, each moved aside into a backup first and all moved back if one fails;
 * data/ and anything else the package does not carry (a bundled node.exe, logs) stay as they are.
 *
 * In a container the program's files belong to the image and are lost when the container is recreated: there the
 * whole release goes to data/llbot-runtime/ on the data volume, which the supervisor of the image starts instead
 * of its own while it is newer. No backup is kept there: the image's own version is the one to fall back to.
 */
export class CoreUpdater {
  private state: CoreUpdateStatus['state'] = 'idle'
  private latest?: PackageVersion
  private error?: string
  private checkedAt?: number
  private blocked?: string
  readonly current: string

  constructor(private readonly options: CoreUpdaterOptions) {
    this.current = options.current ?? runningVersion
  }

  status(): CoreUpdateStatus {
    const latest = this.latest
    const incompatible = latest && this.incompatibility(latest)
    return {
      current: this.current,
      latest: latest?.version,
      available: !!latest && newer(latest.version, this.current) && !incompatible && !this.blocked,
      blocked: this.blocked,
      incompatible,
      state: this.state,
      error: this.error,
      checkedAt: this.checkedAt,
    }
  }

  async check(): Promise<CoreUpdateStatus> {
    if (this.state !== 'idle') return this.status()
    this.state = 'checking'
    this.error = undefined
    try {
      this.blocked = await this.options.blocker?.()
      const document = await this.options.registry().packument(CORE_PACKAGE)
      const tag = document['dist-tags']?.latest
      const latest = tag !== undefined && Object.hasOwn(document.versions ?? {}, tag) ? document.versions[tag] : undefined
      if (!latest || !isExactVersion(latest.version)) throw new CoreUpdateError('npm 上的版本信息不完整：没有有效的 latest 版本', 502)
      this.latest = latest
      this.checkedAt = Date.now()
    } catch (e) {
      this.error = describe(e)
    } finally {
      this.state = 'idle'
    }
    return this.status()
  }

  /** Installs `version`, the one a check reported as latest, and restarts into it */
  async update(version: string): Promise<CoreUpdateStatus> {
    if (this.state !== 'idle') throw new CoreUpdateError('正在检查或安装更新，请稍候', 409)
    if (!isExactVersion(version)) throw new CoreUpdateError('要填写完整的版本号')
    this.state = 'checking'
    this.error = undefined
    const container = this.options.container ?? inContainer()
    const runtime = runtimeDir(this.options.cwd)
    const work = path.join(this.options.installDir, WORK_DIR)
    // Staged next to where it goes, so moving it into place is a rename on the same filesystem
    const staged = container ? `${runtime}.staging-${version}` : path.join(work, `staging-${version}`)
    try {
      this.blocked = await this.options.blocker?.()
      if (this.blocked) throw new CoreUpdateError(this.blocked, 409)
      if (!newer(version, this.current)) throw new CoreUpdateError(`${version} 不比正在运行的 ${this.current} 新`, 409)
      // A mirror may not have a version just published yet: the next registry is asked then
      const document = await this.options.registry().packument(CORE_PACKAGE, false, doc => Object.hasOwn(doc.versions ?? {}, version))
      const release = Object.hasOwn(document.versions ?? {}, version) ? document.versions[version] : undefined
      if (!release) throw new CoreUpdateError(`npm 上没有 ${CORE_PACKAGE}@${version}`, 404)
      if (release.name !== CORE_PACKAGE || release.version !== version) throw new CoreUpdateError('npm 返回的包与请求的版本不符', 502)
      const incompatible = this.incompatibility(release)
      if (incompatible) throw new CoreUpdateError(incompatible, 409)

      this.state = 'downloading'
      const compressed = await this.options.registry().tarball(release)
      this.state = 'installing'
      let tar: Buffer
      try {
        tar = await gunzipAsync(compressed, { maxOutputLength: MAX_TAR })
      } catch {
        throw new CoreUpdateError('下载的更新包无法解压', 502)
      }
      await rm(staged, { recursive: true, force: true })
      await extractPackage(tar, staged)
      await checkStaged(staged, version)
      if (container) {
        await replaceRuntime(staged, runtime)
        this.options.log?.info(`已把 ${version} 安装到数据卷中的 ${runtime}；正在重启`)
      } else {
        const backup = path.join(work, `backup-${this.current}`)
        await rm(backup, { recursive: true, force: true })
        await mkdir(backup, { recursive: true })
        await replaceInstall(this.options.installDir, staged, backup)
        await rm(staged, { recursive: true, force: true })
        this.options.log?.info(`已更新到 ${version}，旧版本的文件在 ${backup}；正在重启`)
      }
      this.state = 'restarting'
      setTimeout(() => {
        if (this.options.restart?.() ?? requestRestart()) return
        // Not expected: the blocker refuses an update no supervisor would restart into
        this.state = 'idle'
        this.error = `已更新到 ${version}，请手动重启 Bot`
      }, this.options.restartDelay ?? 1000)
      return this.status()
    } catch (e) {
      this.state = 'idle'
      this.error = describe(e)
      await rm(staged, { recursive: true, force: true }).catch(() => {})
      throw e instanceof CoreUpdateError ? e : new CoreUpdateError(this.error, e instanceof RegistryError ? 502 : 400)
    }
  }

  /** Leftovers of interrupted updates, and backups but the newest */
  async cleanup(): Promise<void> {
    const runtime = runtimeDir(this.options.cwd)
    for (const name of await readdir(path.dirname(runtime)).catch(() => [] as string[])) {
      if (name.startsWith(`${RUNTIME_DIR_NAME}.staging-`) || name === `${RUNTIME_DIR_NAME}.old`) {
        await rm(path.join(path.dirname(runtime), name), { recursive: true, force: true })
      }
    }
    const work = path.join(this.options.installDir, WORK_DIR)
    let names: string[]
    try {
      names = await readdir(work)
    } catch {
      return
    }
    const backups: { name: string; time: number }[] = []
    for (const name of names) {
      if (name.startsWith('staging-')) await rm(path.join(work, name), { recursive: true, force: true })
      else if (name.startsWith('backup-')) backups.push({ name, time: (await lstat(path.join(work, name))).mtimeMs })
    }
    backups.sort((a, b) => b.time - a.time)
    for (const { name } of backups.slice(1)) await rm(path.join(work, name), { recursive: true, force: true })
  }

  private incompatibility(release: PackageVersion): string | undefined {
    const node = release.engines?.node
    const running = this.options.nodeVersion ?? process.versions.node
    if (node && !matches(running, node)) return `${release.version} 需要 Node.js ${node}，当前是 ${running}`
  }
}

const newer = (version: string, than: string) => {
  try {
    return compareVersions(version, than) > 0
  } catch {
    return false
  }
}

const describe = (e: unknown) => e instanceof RegistryError && e.status === 404
  ? `npm 上还没有 ${CORE_PACKAGE}`
  : e instanceof Error ? e.message : String(e)

/** The download must be a whole release of this very version, supervisor included */
async function checkStaged(staged: string, version: string): Promise<void> {
  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(await readFile(path.join(staged, 'package.json'), 'utf8'))
  } catch {
    throw new CoreUpdateError('更新包里没有有效的 package.json', 502)
  }
  if (!RELEASE_NAMES.includes(manifest.name as string) || manifest.version !== version) {
    throw new CoreUpdateError('更新包的包名或版本与请求的不符', 502)
  }
  for (const file of ['llbot.js', 'llbot-core.js']) {
    if (!existsSync(path.join(staged, file))) throw new CoreUpdateError(`更新包里缺少 ${file}`, 502)
  }
}

/**
 * Moves a staged release into place as the data volume's runtime: the current one aside, the staged one in, the
 * current one back if that fails. A release set aside after failing to start is moot then.
 */
export async function replaceRuntime(staged: string, target: string): Promise<void> {
  const old = `${target}.old`
  await rm(old, { recursive: true, force: true })
  const had = await exists(target)
  if (had) await rename(target, old)
  try {
    await rename(staged, target)
  } catch (error) {
    if (had) await rename(old, target).catch(() => {})
    throw new CoreUpdateError(`安装到 ${target} 失败：${(error as Error).message}`, 409)
  }
  await rm(old, { recursive: true, force: true }).catch(() => {})
  await rm(path.join(path.dirname(target), FAILED_RUNTIME_DIR_NAME), { recursive: true, force: true }).catch(() => {})
}

export interface RenameOps {
  rename(from: string, to: string): Promise<void>
}

/**
 * Moves each entry of `staged` into `installDir`, the entry it replaces into `backup` first. When a move fails,
 * every move made so far is undone in reverse, so the installation is the old one again.
 */
export async function replaceInstall(installDir: string, staged: string, backup: string, ops: RenameOps = { rename }): Promise<void> {
  const names = (await readdir(staged)).filter(name => !PROTECTED.has(name))
  const done: { name: string; replaced: boolean; placed: boolean }[] = []
  try {
    for (const name of names) {
      const target = path.join(installDir, name)
      const step = { name, replaced: await exists(target), placed: false }
      done.push(step)
      if (step.replaced) await ops.rename(target, path.join(backup, name))
      await ops.rename(path.join(staged, name), target)
      step.placed = true
    }
  } catch (error) {
    const stuck: string[] = []
    for (const step of done.reverse()) {
      try {
        if (step.placed) await ops.rename(path.join(installDir, step.name), path.join(staged, step.name))
        if (step.replaced) await ops.rename(path.join(backup, step.name), path.join(installDir, step.name))
      } catch {
        stuck.push(step.name)
      }
    }
    const reason = (error as NodeJS.ErrnoException).code === 'EBUSY' || (error as NodeJS.ErrnoException).code === 'EPERM'
      ? '有文件正被占用' : (error as Error).message
    if (stuck.length) {
      throw new CoreUpdateError(`替换文件失败（${reason}），且 ${stuck.join('、')} 没能还原：旧文件在 ${backup}`, 409)
    }
    throw new CoreUpdateError(`替换文件失败（${reason}），已还原为原来的版本`, 409)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

/** Why the installation in `installDir` cannot update itself, checked in order of what the user can change */
export async function updateBlocker(installDir: string): Promise<string | undefined> {
  let name: unknown
  try {
    name = JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8')).name
  } catch {
    // The source tree has none next to the entry
  }
  if (!RELEASE_NAMES.includes(name as string) || !existsSync(path.join(installDir, 'llbot-core.js'))) {
    return '从源码运行时不能自动更新'
  }
  if (selfUpdateDisabled()) return '已用环境变量 LLBOT_SELF_UPDATE=0 关闭自动更新'
  if (!canRestart()) return '以 --no-supervisor 启动时不能自动更新'
  const others = await runningInstances(currentInstance().name)
  if (others.length) return `实例 ${others.join('、')} 也在用这份程序运行，请先停止它们再更新`
}

export const name = 'core-update'
export const inject = ['plugins', 'http']

/** Mounts the updater: /api/core-update/status, /check and /update, behind the WebUI login */
export function apply(ctx: Context) {
  const installDir = import.meta.dirname
  const updater = new CoreUpdater({
    installDir,
    registry: () => {
      const settings = new MarketSchema(ctx.plugins.entrySettings('builtin:market')?.config as MarketSettings | undefined)
      return new Registries(registriesOf(settings), (url, init) => ctx.http.fetch(url, init))
    },
    blocker: () => updateBlocker(installDir),
    log: ctx.logger('core-update'),
  })
  updater.cleanup().catch(e => ctx.logger('core-update').warn(e))
  ctx.inject(['webuiServer'], (ctx) => {
    ctx.webuiServer.route('/api/core-update', new Hono().route('/api/core-update', createCoreUpdateRoutes(updater)))
  })
}

export function createCoreUpdateRoutes(updater: CoreUpdater): Hono {
  const router = new Hono()
  const respond = async (c: HonoContext, task: () => Promise<unknown>) => {
    try {
      return c.json({ success: true, data: await task() })
    } catch (e) {
      const status = e instanceof CoreUpdateError ? e.status : 500
      return c.json({ success: false, message: e instanceof Error ? e.message : String(e) }, status)
    }
  }
  router.get('/status', c => respond(c, async () => updater.status()))
  router.post('/check', c => respond(c, () => updater.check()))
  router.post('/update', c => respond(c, async () => {
    const body = await c.req.json().catch(() => ({})) as { version?: unknown }
    return updater.update(String(body.version ?? ''))
  }))
  return router
}

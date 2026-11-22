/**
 * Where a container keeps a self-installed release, and which release starts. Shared by the supervisor
 * (llbot.js) and the updater, so it imports nothing of the bot.
 *
 * A container's program files belong to its image and are gone when the container is recreated. A release the
 * bot installs itself therefore goes to the data volume, data/llbot-runtime/, and the supervisor of the image
 * starts it instead of the image's own when it is newer. A newer image wins again, and the leftover is removed.
 */
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { compareVersions, satisfies } from 'compare-versions'

export const RUNTIME_DIR_NAME = 'llbot-runtime'
/** Where a release that kept crashing at startup is set aside, for a look or a manual rename back */
export const FAILED_RUNTIME_DIR_NAME = 'llbot-runtime.failed'

/** What the package.json of an installation may be called: the package releases are published as, or the name before */
export const RELEASE_NAMES = ['@luckylillia-dev/luckylillia', 'llonebot-dist']

/** data/ is relative to the working directory, as everywhere in the bot (common/globalVars.ts) */
export const runtimeDir = (cwd = process.cwd()) => path.join(cwd, 'data', RUNTIME_DIR_NAME)
export const failedRuntimeDir = (cwd = process.cwd()) => path.join(cwd, 'data', FAILED_RUNTIME_DIR_NAME)

/**
 * In a container: Docker's /.dockerenv, Podman's /run/.containerenv, or LLBOT_CONTAINER=1 (Kubernetes and other
 * runtimes leave no marker; the official images set it). LLBOT_CONTAINER=0 says it is not one.
 */
export function inContainer(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): boolean {
  if (env.LLBOT_CONTAINER === '1') return true
  if (env.LLBOT_CONTAINER === '0') return false
  return exists('/.dockerenv') || exists('/run/.containerenv')
}

export interface Release {
  dir: string
  version: string
  /** Node.js the release needs, from its package.json engines */
  node?: string
}

/** The release in `dir`, if it is a whole one: a known package with a version, and both entries */
export function readRelease(dir: string): Release | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (!RELEASE_NAMES.includes(manifest.name) || typeof manifest.version !== 'string') return
    if (!existsSync(path.join(dir, 'llbot.js')) || !existsSync(path.join(dir, 'llbot-core.js'))) return
    return { dir, version: manifest.version, node: typeof manifest.engines?.node === 'string' ? manifest.engines.node : undefined }
  } catch {
    return undefined
  }
}

export function newer(version: string, than: string): boolean {
  try {
    return compareVersions(version, than) > 0
  } catch {
    return false
  }
}

/** Whether `node` satisfies an engines range such as ">=22.15"; a range compare-versions cannot read does not block */
export function nodeSatisfies(range: string | undefined, node = process.versions.node): boolean {
  if (!range) return true
  try {
    return satisfies(node, range)
  } catch {
    return true
  }
}

export interface CoreChoice {
  /** llbot-core.js to start */
  core: string
  /** Set when it is the release in the data volume rather than the program's own */
  runtime?: Release
  /** Why the release in the data volume is not started, for the log */
  note?: string
}

export interface ChooseOptions {
  /** Where llbot.js runs from: the image's program directory in a container */
  installDir: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  node?: string
  container?: boolean
}

/**
 * The core to start now: the data volume's release when this is a container, it is a whole release newer than
 * the program's own and it runs on this Node.js; the program's own otherwise. A release in the volume that is not
 * newer is removed: a newer image superseded it.
 */
export function chooseCore(options: ChooseOptions): CoreChoice {
  const own: CoreChoice = { core: path.join(options.installDir, 'llbot-core.js') }
  const env = options.env ?? process.env
  if (!(options.container ?? inContainer(env))) return own
  const dir = runtimeDir(options.cwd)
  if (!existsSync(dir)) return own
  const runtime = readRelease(dir)
  if (!runtime) return { ...own, note: `${dir} 不是完整的发布包，使用镜像自带的版本` }
  const image = readRelease(options.installDir)
  if (image && !newer(runtime.version, image.version)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return { ...own, note: `镜像自带的 ${image.version} 不比自动更新的 ${runtime.version} 旧，已删除 ${dir}` }
    } catch (error) {
      return { ...own, note: `镜像自带的版本更新，但删除 ${dir} 失败：${(error as Error).message}` }
    }
  }
  if (!nodeSatisfies(runtime.node, options.node)) {
    return { ...own, note: `自动更新的 ${runtime.version} 需要 Node.js ${runtime.node}，当前是 ${options.node ?? process.versions.node}，使用镜像自带的版本` }
  }
  return { core: path.join(dir, 'llbot-core.js'), runtime }
}

/** Sets a release that keeps crashing at startup aside, replacing one set aside before */
export function setRuntimeAside(cwd = process.cwd()): string {
  const failed = failedRuntimeDir(cwd)
  rmSync(failed, { recursive: true, force: true })
  renameSync(runtimeDir(cwd), failed)
  return failed
}

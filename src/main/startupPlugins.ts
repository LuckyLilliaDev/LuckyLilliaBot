import path from 'node:path'
import { realpathSync } from 'node:fs'
import { Context } from 'cordis'
import { isPlainObject } from '@/common/schema/diff'
import { parseJsonLike, type ConfigPatch } from '@/common/schema/patch'
import type { PluginStatus } from '@/plugin/host'
import { currentPackageName, RENAMED_PACKAGES } from '@/plugin/host/renamed'
import { Market } from '@/plugin/internal/tool/market/index'
import { isPackageName, Registries } from '@/plugin/internal/tool/market/registry'
import { MarketSchema, registriesOf, type MarketSettings } from '@/plugin/internal/tool/market/settings'

const BUILTIN_NAME = /^builtin:[a-z0-9][a-z0-9-]*$/
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const OFFICIAL_PLUGIN_PREFIX = '@luckylillia-dev/plugin-'
const OFFICIAL_PACKAGES = [...new Set(
  Object.values(RENAMED_PACKAGES).filter(name => name.startsWith(OFFICIAL_PLUGIN_PREFIX) && name !== '@luckylillia-dev/plugin-sdk'),
)]
/** Builtins that affect network/registry access apply first so subsequent npm installs pick them up. */
const EARLY_BUILTINS = ['builtin:proxy', 'builtin:market']

export interface StartupPluginConfig {
  /** Builtin entry (`builtin:*`), full npm package name, or friendly short name */
  plugin: string
  patch: ConfigPatch
}

/** Only npm names: repeat --plugin, or put several comma-separated names in one value. */
export function startupPluginNames(argv: readonly string[] = process.argv): string[] {
  const names = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') break
    let value: string | undefined
    if (arg === '--plugin') value = argv[++index]
    else if (arg.startsWith('--plugin=')) value = arg.slice('--plugin='.length)
    else continue
    if (!value) throw new Error('--plugin 需要 npm 包名，可重复指定多个包')
    for (const part of value.split(',')) {
      const name = part.trim()
      if (!isPackageName(name)) throw new Error('--plugin 只接受 npm 包名，不接受版本、路径或 URL')
      // Launch commands written before the move to @luckylillia-dev keep working
      names.add(currentPackageName(name))
    }
    if (names.size > 128) throw new Error('--plugin 最多指定 128 个插件包')
  }
  return [...names]
}

function splitConfigTarget(lhs: string): { plugin: string; fieldPath?: string } {
  if (lhs.startsWith('builtin:')) {
    const rest = lhs.slice('builtin:'.length)
    const colon = rest.indexOf(':')
    if (colon < 0) return { plugin: lhs }
    return { plugin: lhs.slice(0, 'builtin:'.length + colon), fieldPath: rest.slice(colon + 1) }
  }
  const colon = lhs.indexOf(':')
  if (colon < 0) return { plugin: lhs }
  return { plugin: lhs.slice(0, colon), fieldPath: lhs.slice(colon + 1) }
}

/**
 * Parses one `--plugin-config` value in either form:
 * - Path assignment: `<plugin>:<path>=<value>` (e.g. `qq-official:appId=123456`, `onebot11:connect.0.url=ws://...`)
 * - JSON/JSON5 object merge: `<plugin>={...}` (e.g. `satori={"port":5500}`)
 */
export function parsePluginConfigSpec(raw: string): StartupPluginConfig {
  const eq = raw.indexOf('=')
  if (eq <= 0) {
    throw new Error('--plugin-config 格式应为 <插件>:<字段>=<值> 或 <插件>={JSON}，例如 --plugin-config qq-official:appId=123456')
  }
  const lhs = raw.slice(0, eq).trim()
  const rhs = raw.slice(eq + 1)
  const { plugin: rawPlugin, fieldPath } = splitConfigTarget(lhs)
  const plugin = rawPlugin.trim()
  if (plugin.startsWith('builtin:')) {
    if (!BUILTIN_NAME.test(plugin)) throw new Error(`--plugin-config 插件名「${plugin}」无效`)
  } else if (!isPackageName(plugin)) {
    throw new Error(`--plugin-config 插件名「${plugin}」无效，请填写短名、builtin:<名称> 或 npm 包名`)
  }
  const normalizedPlugin = plugin.startsWith('builtin:') ? plugin : currentPackageName(plugin)

  if (fieldPath !== undefined) {
    const trimmedPath = fieldPath.trim()
    if (!trimmedPath) throw new Error(`--plugin-config「${lhs}」缺少字段名`)
    const segments = trimmedPath.split('.')
    if (segments.some(segment => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
      throw new Error(`--plugin-config 字段路径「${trimmedPath}」无效`)
    }
    return { plugin: normalizedPlugin, patch: { kind: 'set', path: segments, raw: rhs } }
  }

  const parsed = parseJsonLike(rhs.trim(), `--plugin-config ${normalizedPlugin}`)
  if (!isPlainObject(parsed)) {
    throw new Error(`--plugin-config ${normalizedPlugin}=<JSON> 必须是 JSON 对象，例如 --plugin-config '${normalizedPlugin}={"key":"value"}'`)
  }
  return { plugin: normalizedPlugin, patch: { kind: 'merge', value: parsed } }
}

/** Collects `--plugin-config <spec>` / `--plugin-config=<spec>` arguments in order. */
export function startupPluginConfigs(argv: readonly string[] = process.argv): StartupPluginConfig[] {
  const configs: StartupPluginConfig[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') break
    let value: string | undefined
    if (arg === '--plugin-config') {
      const next = argv[index + 1]
      if (next === undefined || (next.startsWith('-') && !next.includes('='))) {
        throw new Error('--plugin-config 需要配置参数，例如 --plugin-config qq-official:appId=123456')
      }
      value = argv[++index]
    } else if (arg.startsWith('--plugin-config=')) {
      value = arg.slice('--plugin-config='.length)
    } else continue
    if (!value) throw new Error('--plugin-config 需要配置参数，例如 --plugin-config qq-official:appId=123456')
    configs.push(parsePluginConfigSpec(value))
    if (configs.length > 256) throw new Error('--plugin-config 最多指定 256 项配置')
  }
  return configs
}

function redactConfigValue(raw: string): string {
  const eq = raw.indexOf('=')
  if (eq <= 0) return '***'
  const lhs = raw.slice(0, eq).trim()
  const { plugin, fieldPath } = splitConfigTarget(lhs)
  return fieldPath !== undefined ? `${plugin}:${fieldPath}=***` : `${plugin}={...}`
}

/** Keeps `--plugin-config` targets visible in startup logs without leaking secrets or tokens. */
export function redactStartupArgv(argv: readonly string[]): string[] {
  const redacted: string[] = []
  let stop = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!stop && arg === '--') {
      stop = true
      redacted.push(arg)
      continue
    }
    if (!stop && arg === '--plugin-config' && index + 1 < argv.length) {
      redacted.push(arg, redactConfigValue(argv[++index]))
      continue
    }
    if (!stop && arg.startsWith('--plugin-config=')) {
      redacted.push(`--plugin-config=${redactConfigValue(arg.slice('--plugin-config='.length))}`)
      continue
    }
    redacted.push(arg)
  }
  return redacted
}

function shortAliasOf(pkgName: string): string {
  const bare = pkgName.includes('/') ? pkgName.slice(pkgName.indexOf('/') + 1) : pkgName
  return bare.replace(/^(?:lucky-?lillia-plugin-|plugin-)/, '')
}

/**
 * Resolves a user-friendly target (`qq-official`, `onebot11`, `builtin:proxy`, `@luckylillia-dev/plugin-milky`, ...)
 * to the canonical builtin entry name or npm package name.
 */
export function resolvePluginConfigTarget(
  rawTarget: string,
  builtins: readonly string[],
  knownPackages: readonly string[],
): string {
  if (rawTarget.startsWith('builtin:')) {
    if (builtins.includes(rawTarget)) return rawTarget
    const names = builtins.map(name => name.slice('builtin:'.length)).join('、')
    throw new Error(`找不到内置插件「${rawTarget}」，可用内置插件：${names}`)
  }
  const canonical = currentPackageName(rawTarget)
  if (canonical.includes('/')) return canonical

  const asBuiltin = `builtin:${canonical}`
  if (builtins.includes(asBuiltin)) return asBuiltin

  const uniqueKnown = [...new Set(knownPackages)]
  if (uniqueKnown.includes(canonical)) return canonical

  const officialCandidates = [
    `${OFFICIAL_PLUGIN_PREFIX}${canonical}`,
    `@luckylillia-dev/${canonical}`,
  ]
  for (const candidate of officialCandidates) {
    if (uniqueKnown.includes(candidate)) return candidate
  }

  const suffixMatches = uniqueKnown.filter(pkg => {
    const bare = pkg.includes('/') ? pkg.slice(pkg.indexOf('/') + 1) : pkg
    return bare === canonical || shortAliasOf(pkg) === canonical
  })
  if (suffixMatches.length === 1) return suffixMatches[0]
  if (suffixMatches.length > 1) {
    throw new Error(`插件短名「${rawTarget}」匹配到多个插件（${suffixMatches.join('、')}），请填写完整包名`)
  }

  for (const candidate of officialCandidates) {
    if (OFFICIAL_PACKAGES.includes(candidate)) return candidate
  }
  return canonical
}

function summarizePatches(patches: readonly ConfigPatch[]): string {
  const keys = new Set<string>()
  for (const patch of patches) {
    if (patch.kind === 'set') keys.add(patch.path.join('.'))
    else for (const key of Object.keys(patch.value)) keys.add(key)
  }
  return [...keys].join('、') || '配置'
}

type RequestedInstaller = Pick<Market, 'ensureRequested'>

/** Do not include registry credentials or signed tarball queries in startup errors. */
export function startupPluginError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s，。；、）)》」"']+/g, raw => {
    const trailing = raw.endsWith(':') ? ':' : ''
    const candidate = trailing ? raw.slice(0, -1) : raw
    try {
      const url = new URL(candidate)
      return (url.pathname === '/' && !candidate.endsWith('/') ? url.origin : url.origin + url.pathname) + trailing
    } catch {
      return '[registry URL]' + trailing
    }
  })
}

function installer(ctx: Context): RequestedInstaller {
  const first = ctx.plugins.config.roots[0]
  if (!first) throw new Error('没有可安装插件的目录')
  let root = path.resolve(first)
  try { root = realpathSync(root) } catch { /* the installer creates a missing root */ }
  const config = new MarketSchema(ctx.plugins.entrySettings('builtin:market')?.config as MarketSettings | undefined)
  return new Market(ctx, new Registries(registriesOf(config), (url, init) => ctx.http.fetch(url, init)), root)
}

/** CLI selection explicitly authorizes trust for requested packages and their required plugin dependencies. */
export async function startRequestedPlugins(
  ctx: Context,
  names: readonly string[],
  source?: RequestedInstaller,
  configs: readonly StartupPluginConfig[] = [],
): Promise<void> {
  if (!names.length && !configs.length) return
  const logger = ctx.logger('startup-plugins')
  const listed = ctx.plugins.list()
  const builtins = listed.filter(entry => entry.builtin).map(entry => entry.name)
  const knownPackages = [
    ...listed.filter(entry => !entry.builtin).map(entry => entry.packageName ?? entry.name),
    ...names,
  ]

  const builtinPatches = new Map<string, ConfigPatch[]>()
  const packagePatches = new Map<string, ConfigPatch[]>()
  const packageTargets = new Set<string>(names)
  for (const item of configs) {
    const target = resolvePluginConfigTarget(item.plugin, builtins, knownPackages)
    const bucket = target.startsWith('builtin:') ? builtinPatches : packagePatches
    const group = bucket.get(target) ?? []
    group.push(item.patch)
    bucket.set(target, group)
    if (!target.startsWith('builtin:')) packageTargets.add(target)
  }

  const failures: string[] = []
  const check = (status: PluginStatus) => {
    if (['failed', 'missing', 'incompatible'].includes(status.state) || status.disabled || (!status.builtin && !status.trusted)) {
      throw new Error(status.error ?? `${status.name} 未能启用（${status.state}）`)
    }
    // Pending services such as QQ login are expected; enabling a plugin does not promise an account is online.
    logger.info(`${status.name} 已启用${status.state === 'pending' ? '，等待所需服务就绪' : ''}`)
  }

  // Stage 1: apply builtin configs first (proxy & market before others so npm installs use them).
  const orderedBuiltins = [
    ...EARLY_BUILTINS.filter(name => builtinPatches.has(name)),
    ...[...builtinPatches.keys()].filter(name => !EARLY_BUILTINS.includes(name)),
  ]
  for (const name of orderedBuiltins) {
    const patches = builtinPatches.get(name)!
    try {
      const entry = ctx.plugins.list().find(item => item.name === name)
      if (!entry) throw new Error(`找不到内置插件 ${name}`)
      const updated = await ctx.plugins.patchConfig(entry.id, patches, { enabled: true })
      logger.info(`${name} 已应用命令行配置（${summarizePatches(patches)}）`)
      const status = entry.disabled
        ? await ctx.plugins.enable(entry.id, { trust: true })
        : updated
      check(status)
    } catch (error) {
      const message = `${name}: ${startupPluginError(error)}`
      logger.error(message)
      failures.push(message)
    }
  }

  if (packageTargets.size) {
    const market = source ?? installer(ctx)
    const completed = new Set<string>()
    for (const requested of packageTargets) {
      try {
        const plan = await market.ensureRequested(requested)
        for (const name of plan.names) {
          if (completed.has(name)) continue
          const patches = packagePatches.get(name)
          const entries = ctx.plugins.list().filter(entry => entry.name === name || entry.packageName === name)
          if (!entries.length) {
            if (patches?.length) {
              const created = await ctx.plugins.add(name, undefined, { trust: true, disabled: true })
              await ctx.plugins.patchConfig(created.id, patches, { enabled: true })
              logger.info(`${name} 已应用命令行配置（${summarizePatches(patches)}）`)
              check(await ctx.plugins.enable(created.id, { trust: true }))
            } else {
              check(await ctx.plugins.add(name, undefined, { trust: true }))
            }
          } else {
            // Preserve multi-entry choices: keep all previously enabled entries, otherwise enable the first saved one.
            const enabled = entries.filter(entry => !entry.disabled)
            const targets = enabled.length ? enabled : entries.slice(0, 1)
            for (const entry of targets) {
              if (patches?.length) {
                await ctx.plugins.patchConfig(entry.id, patches, { enabled: true })
                logger.info(`${name} 已应用命令行配置（${summarizePatches(patches)}）`)
              }
              check(await ctx.plugins.enable(entry.id, { trust: true }))
            }
          }
          completed.add(name)
        }
      } catch (error) {
        const message = `${requested}: ${startupPluginError(error)}`
        logger.error(message)
        failures.push(message)
      }
    }
  }

  if (failures.length) throw new Error(`启动插件未全部就绪：${failures.join('; ')}`)
}

import path from 'node:path'
import { realpathSync } from 'node:fs'
import { Context } from 'cordis'
import { isPlainObject } from '@/common/schema/diff'
import { parseJsonLike, type ConfigPatch } from '@/common/schema/patch'
import type { LaunchSetting } from '@luckylillia-dev/plugin-sdk'
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
/** The `=` between target and value: one inside a list selector (`connect[type=ws]`) is part of the path. */
function assignmentAt(raw: string): number {
  let depth = 0
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (char === '[') depth++
    else if (char === ']') depth = Math.max(0, depth - 1)
    else if (char === '=' && !depth) return index
  }
  return -1
}

export function parsePluginConfigSpec(raw: string): StartupPluginConfig {
  const eq = assignmentAt(raw)
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

/** LLBot's own flags, which no plugin may declare in `llbot.launch`; every `--plugin*` flag is LLBot's as well. */
const HOST_FLAGS = new Set(['--instance', '--webui-port', '--parent-pid', '--dev', '--debug', '--no-supervisor', '--no-manager'])
const ARG_NAME = /^--[a-z0-9][a-z0-9-]*$/
/** Variables no plugin may declare: LLBot's own (`LLBOT_*`), Node's and npm's, and the system's. */
const HOST_ENV_PREFIXES = ['LLBOT_', 'NODE_', 'NPM_', 'npm_']
const SYSTEM_ENV = new Set(['PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'LANG', 'TZ', 'TMP', 'TEMP', 'TMPDIR', 'PWD', 'HOSTNAME'])
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/** Who declares launch settings (`llbot.launch`): a builtin by its entry (`builtin:satori`), a package by its name. */
export interface PluginLaunchSource {
  target: string
  launch: unknown
}

type Declared = Map<string, { target: string; setting: LaunchSetting } | { problem: string }>

interface Kind {
  key: 'arg' | 'env'
  /** 参数 / 环境变量 */
  noun: string
  /** Why a plugin cannot have this name at all: it is never the plugin's, whoever uses it. */
  nameProblem(name: string): string | undefined
}

const FLAGS: Kind = {
  key: 'arg',
  noun: '参数',
  nameProblem: flag => !ARG_NAME.test(flag) ? '参数名只能是 --小写字母、数字和 -'
    : flag.startsWith('--plugin') || HOST_FLAGS.has(flag) ? '和 LLBot 自己的参数重名' : undefined,
}

const VARIABLES: Kind = {
  key: 'env',
  noun: '环境变量',
  nameProblem: name => !ENV_NAME.test(name) ? '变量名只能是大写字母、数字和 _'
    : HOST_ENV_PREFIXES.some(prefix => name.startsWith(prefix)) || SYSTEM_ENV.has(name) ? '是 LLBot 或系统自己的变量' : undefined,
}

/** What is wrong with a `llbot.launch` item, apart from its names. */
function settingProblem(setting: Record<string, unknown>): string | undefined {
  if (typeof setting.field !== 'string' || !setting.field.trim()) return '要用 field 写出对应的配置字段'
  if (setting.arg === undefined && setting.env === undefined) return '要写出 arg 或 env'
  const { aliases, set } = setting
  if (aliases !== undefined && (!isPlainObject(aliases) || Object.values(aliases).some(v => typeof v !== 'string'))) {
    return 'aliases 要是 { 给出的值: 配置里的值 }'
  }
  if (set !== undefined && (!isPlainObject(set) || Object.values(set).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
    return 'set 要是 { 字段: 值 }'
  }
}

/**
 * The flags or the variables the plugins declare. An item that is invalid, or a name two plugins declare, is only a
 * warning until the name is used; a name a plugin may not have at all is dropped.
 */
function declarations(sources: readonly PluginLaunchSource[], kind: Kind, warn: (message: string) => void): Declared {
  const declared: Declared = new Map()
  for (const { target, launch } of sources) {
    if (!Array.isArray(launch)) continue
    for (const item of launch) {
      if (!isPlainObject(item)) continue
      const name = item[kind.key]
      if (name === undefined) continue
      if (typeof name !== 'string') {
        warn(`${target} 的 llbot.launch 里 ${kind.key} 要是字符串，已忽略`)
        continue
      }
      const badName = kind.nameProblem(name)
      if (badName) {
        warn(`${target} 声明的${kind.noun} ${name} 无效（${badName}），已忽略`)
        continue
      }
      const problem = settingProblem(item)
      const other = declared.get(name)
      if (problem) {
        warn(`${target} 声明的${kind.noun} ${name} 无效（${problem}），已忽略`)
        if (!other) declared.set(name, { problem: `${target} 声明的${kind.noun} ${name} 无效：${problem}` })
      } else if (other && 'target' in other && other.target !== target) {
        const message = `${kind.noun} ${name} 同时由 ${other.target} 和 ${target} 声明，无法确定交给谁`
        warn(message)
        declared.set(name, { problem: message })
      } else if (!other || 'target' in other) {
        declared.set(name, { target, setting: item as unknown as LaunchSetting })
      }
    }
  }
  return declared
}

function pathPatch(target: string, fieldPath: string, raw: string, name: string): StartupPluginConfig {
  const segments = fieldPath.trim().split('.')
  if (segments.some(segment => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error(`${target} 的 ${name} 对应的字段「${fieldPath}」无效`)
  }
  return { plugin: target, patch: { kind: 'set', path: segments, raw } }
}

/** The settings one given value writes: its field, then what the item sets along with it. */
function patchesOf({ target, setting }: { target: string; setting: LaunchSetting }, raw: string, name: string): StartupPluginConfig[] {
  return [
    pathPatch(target, setting.field, setting.aliases?.[raw] ?? raw, name),
    ...Object.entries(setting.set ?? {}).map(([field, value]) => pathPatch(target, field, String(value), name)),
  ]
}

/**
 * The settings that the launch flags and environment variables installed plugins declare (`llbot.launch`) write, as
 * `--plugin-config` would: the variables first, then the flags in command-line order, so a flag wins over a variable
 * for the same field. A flag or variable nobody declares is left alone: LLBot or a plugin may read it itself. An empty
 * variable counts as unset, as `NAME=` in a compose file whose value is not given.
 */
export function startupLaunchSettings(
  sources: readonly PluginLaunchSource[],
  argv: readonly string[] = process.argv,
  warn: (message: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): StartupPluginConfig[] {
  const configs: StartupPluginConfig[] = []
  for (const sourceProblem of sources.filter(source => source.launch !== undefined && !Array.isArray(source.launch))) {
    warn(`${sourceProblem.target} 的 llbot.launch 要是列表，已忽略`)
  }
  for (const [name, found] of declarations(sources, VARIABLES, warn)) {
    const raw = env[name]
    if (raw === undefined || !raw.trim()) continue
    if ('problem' in found) throw new Error(found.problem)
    configs.push(...patchesOf(found, raw.trim(), name))
  }
  const flags = declarations(sources, FLAGS, warn)
  if (flags.size) {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]
      if (arg === '--') break
      const eq = arg.indexOf('=')
      const flag = eq < 0 ? arg : arg.slice(0, eq)
      const found = flags.get(flag)
      if (!found) continue
      if ('problem' in found) throw new Error(found.problem)
      let raw: string | undefined
      if (eq >= 0) raw = arg.slice(eq + 1)
      else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) raw = argv[++index]
      if (raw === undefined) throw new Error(`参数 ${flag} 需要一个值，例如 ${flag}=<值>`)
      configs.push(...patchesOf(found, raw, flag))
    }
  }
  if (configs.length > 256) throw new Error('启动参数和环境变量最多写入 256 项配置')
  return configs
}

/** The launch settings the plugins found declare, for startupLaunchSettings(). */
export function pluginLaunchSources(ctx: Context): PluginLaunchSource[] {
  const sources = new Map<string, PluginLaunchSource>()
  for (const pkg of ctx.plugins.packageList()) {
    // An update of a builtin's package goes by the builtin's entry; its code declares them (below)
    const entry = (pkg.manifest as { builtin?: { entry?: unknown } }).builtin?.entry
    if (typeof entry === 'string' && entry.startsWith('builtin:')) continue
    if (pkg.manifest.launch !== undefined) sources.set(pkg.name, { target: pkg.name, launch: pkg.manifest.launch })
  }
  for (const status of ctx.plugins.list()) {
    if (status.builtin && status.manifest.launch !== undefined) sources.set(status.name, { target: status.name, launch: status.manifest.launch })
  }
  return [...sources.values()]
}

/** Flag names that look like they carry a secret, whoever reads the flag: the startup log shows *** instead. */
const SECRET_FLAG = /-(?:token|secret|password|key)$/

function redactConfigValue(raw: string): string {
  const eq = assignmentAt(raw)
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
    if (!stop && arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const flag = eq < 0 ? arg : arg.slice(0, eq)
      if (SECRET_FLAG.test(flag)) {
        if (eq >= 0) redacted.push(`${flag}=***`)
        else {
          redacted.push(arg)
          if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) { index++; redacted.push('***') }
        }
        continue
      }
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
  /**
   * The launch settings (`llbot.launch`) of packages installed just now, which were not there to read before: they go
   * into the new entry before it is enabled, ahead of what `--plugin-config` says for it.
   */
  installedLaunch?: (packages: readonly string[]) => StartupPluginConfig[],
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
        const fromLaunch = new Map<string, ConfigPatch[]>()
        for (const item of installedLaunch?.(plan.names.filter(name => !completed.has(name))) ?? []) {
          if (!item.plugin.startsWith('builtin:')) fromLaunch.set(item.plugin, [...fromLaunch.get(item.plugin) ?? [], item.patch])
        }
        for (const name of plan.names) {
          if (completed.has(name)) continue
          const patches = [...fromLaunch.get(name) ?? [], ...packagePatches.get(name) ?? []]
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

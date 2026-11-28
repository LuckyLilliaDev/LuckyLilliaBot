import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinRuntimeModule } from './builtin-runtime'

/** Packages a plugin must share with the host: a second copy of cordis breaks services and events. */
export const SHARED_SPECIFIERS = [
  '@luckylillia-dev/plugin-sdk',
  'cordis',
  'cosmokit',
  'schemastery',
  '@standard-schema/spec',
  '@satorijs/element',
  '@satorijs/protocol',
] as const

export interface ResolverState {
  /** Bare specifier -> the URL the host itself resolves it to. */
  shared: Map<string, string>
  /** Plugin package directories as file URLs ending with a slash. */
  roots: string[]
}

/** What plugins published before the move to @luckylillia-dev import, and the shared package it is now. */
export const LEGACY_SPECIFIERS: Readonly<Record<string, (typeof SHARED_SPECIFIERS)[number]>> = {
  '@luckylillia/plugin-sdk': '@luckylillia-dev/plugin-sdk',
}

export function sharedSpecifierMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const specifier of SHARED_SPECIFIERS) {
    try {
      map.set(specifier, import.meta.resolve(specifier))
    } catch {
      // e.g. the SDK is not built yet in a fresh checkout
    }
  }
  for (const [legacy, current] of Object.entries(LEGACY_SPECIFIERS)) {
    const url = map.get(current)
    if (url) map.set(legacy, url)
  }
  return map
}

/**
 * Two jobs: pin shared packages to the host copy, and copy the `?v=` reload epoch from a plugin module
 * to the ES modules it imports inside the same package. Without the latter only the entry would be
 * re-evaluated on reload and every relative import would come back from the ESM cache. CommonJS files keep
 * their plain URL: imported with a query, Node evaluates them apart from require() and their exports come out
 * wrong (a reload of the NTQQ plugin failed on `debug`, imported by an ES module in its node_modules). The host
 * clears them from require.cache for a reload instead.
 */
export function resolvePluginSpecifier(
  state: ResolverState,
  specifier: string,
  context: nodeModule.ResolveHookContext,
  nextResolve: (specifier: string, context?: Partial<nodeModule.ResolveHookContext>) => nodeModule.ResolveFnOutput,
  /** Whether the nearest package.json of a directory (a file URL) says "type": "module"; tests pass their own. */
  moduleType: (dirUrl: string) => boolean = isModulePackage,
): nodeModule.ResolveFnOutput {
  const internal = builtinRuntimeModule(specifier)
  if (internal) return { url: internal, shortCircuit: true }
  const pinned = state.shared.get(specifier)
  if (pinned) return { url: pinned, shortCircuit: true }
  const result = nextResolve(specifier, context)
  const parent = context.parentURL
  if (!parent?.startsWith('file:') || !result.url.startsWith('file:')) return result
  const epoch = new URL(parent).searchParams.get('v')
  if (!epoch) return result
  const root = packageRootOf(state.roots, parent)
  if (!root || !stripQuery(result.url).startsWith(root) || isCommonJS(result.url, moduleType)) return result
  const url = new URL(result.url)
  url.searchParams.set('v', epoch)
  return { ...result, url: url.href }
}

/** Returns undefined when this Node has no module.registerHooks (added in 22.15). */
export function installPluginResolver(state: ResolverState): (() => void) | undefined {
  const registerHooks = (nodeModule as Partial<typeof nodeModule>).registerHooks
  if (!registerHooks) return
  const hooks = registerHooks({
    resolve: (specifier, context, nextResolve) => resolvePluginSpecifier(state, specifier, context, nextResolve),
  })
  return () => hooks.deregister()
}

function packageRootOf(roots: string[], url: string): string | undefined {
  const bare = stripQuery(url)
  let best: string | undefined
  for (const root of roots) {
    if (bare.startsWith(root) && (!best || root.length > best.length)) best = root
  }
  return best
}

const packageTypes = new Map<string, boolean>()

/**
 * Whether the nearest package.json of a directory (a file URL) says "type": "module". Read once per directory:
 * a reload does not change it.
 */
export function isModulePackage(dirUrl: string): boolean {
  let dir: string
  try {
    dir = fileURLToPath(dirUrl)
  } catch {
    return false
  }
  return moduleIn(path.resolve(dir))
}

function moduleIn(dir: string): boolean {
  const known = packageTypes.get(dir)
  if (known !== undefined) return known
  let module: boolean
  try {
    module = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).type === 'module'
  } catch {
    const parent = path.dirname(dir)
    module = parent !== dir && moduleIn(parent)
  }
  packageTypes.set(dir, module)
  return module
}

/** How Node decides it: .cjs, or .js without "type": "module" in the nearest package.json. */
export function isCommonJS(url: string, moduleType: (dirUrl: string) => boolean): boolean {
  const bare = stripQuery(url)
  if (bare.endsWith('.cjs')) return true
  if (!bare.endsWith('.js')) return false
  return !moduleType(new URL('.', bare).href)
}

function stripQuery(url: string): string {
  const index = url.search(/[?#]/)
  return index < 0 ? url : url.slice(0, index)
}

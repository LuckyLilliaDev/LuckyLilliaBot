import type { PluginCatalogItem, PluginInstalledPackage, PluginUpdateInfo } from '@luckylillia-dev/plugin-sdk/webui'
import type { PluginStatus } from '../../types/plugins'
import type { CatalogSource } from './catalog'
import { CATEGORIES, needsAttention, type CategoryKey, type OriginFilter, type StatusFilter } from './listing'
import { pluginDescription, pluginTitle } from './meta'

export type InstallationFilter = 'installed' | 'uninstalled' | 'all'
export interface PluginListItem {
  key: string
  plugin?: PluginStatus
  catalog?: PluginCatalogItem
  packageStatus?: PluginInstalledPackage
  updateInfo?: PluginUpdateInfo
  source?: CatalogSource
}

export const isInstalled = (item: PluginListItem) => !!(item.plugin || item.packageStatus)
export const itemName = (item: PluginListItem) => item.packageStatus?.name ?? item.plugin?.packageName ?? item.catalog?.name ?? item.plugin!.name
export const itemTitle = (item: PluginListItem) => item.plugin ? pluginTitle(item.plugin) : item.packageStatus?.title ?? item.catalog?.title ?? itemName(item)
export const itemBuiltin = (item: PluginListItem) => !!(item.plugin?.builtin || item.packageStatus?.builtin || item.catalog?.builtin)
export const itemCategory = (item: PluginListItem): CategoryKey => {
  const value = item.plugin?.manifest.category ?? item.catalog?.category
  return CATEGORIES.find(category => category.key === value)?.key ?? 'other'
}

/** Merge current plugin data and preserve the order of cards already shown on this visit. */
export function mergePluginItems(plugins: PluginStatus[], sources: CatalogSource[], itemOrder: readonly string[] = []): PluginListItem[] {
  const catalog = new Map<string, { entry: PluginCatalogItem; source: CatalogSource }>()
  const packages = new Map<string, { pkg: PluginInstalledPackage; source: CatalogSource }>()
  for (const source of sources) {
    for (const entry of source.state.items ?? []) if (!catalog.has(entry.name)) catalog.set(entry.name, { entry, source })
    for (const pkg of source.state.installed ?? []) if (!packages.has(pkg.name)) packages.set(pkg.name, { pkg, source })
  }
  const seen = new Set<string>()
  const items: PluginListItem[] = plugins.map(plugin => {
    const name = plugin.packageName ?? [...packages.values()].find(({ pkg }) => pkg.builtin === plugin.name)?.pkg.name ?? plugin.name
    const known = catalog.get(name) ?? [...catalog.values()].find(({ entry }) => entry.builtin === plugin.name)
    const installed = packages.get(name)
    seen.add(name)
    if (known) seen.add(known.entry.name)
    const source = installed?.source ?? known?.source
    return { key: `entry:${plugin.id}`, plugin, catalog: known?.entry, packageStatus: installed?.pkg, source, updateInfo: source?.state.updates?.[name] }
  })
  for (const [name, { pkg, source }] of packages) {
    if (seen.has(name)) continue
    seen.add(name)
    items.push({ key: `package:${name}`, packageStatus: pkg, catalog: catalog.get(name)?.entry, source, updateInfo: source.state.updates?.[name] })
  }
  for (const [name, { entry, source }] of catalog) {
    if (!seen.has(name)) items.push({ key: `catalog:${name}`, catalog: entry, source })
  }
  const remaining = new Map(items.map(item => [item.key, item]))
  const ordered: PluginListItem[] = []
  for (const key of itemOrder) {
    const item = remaining.get(key)
    if (!item) continue
    ordered.push(item)
    remaining.delete(key)
  }

  const rank = (item: PluginListItem) => CATEGORIES.findIndex(category => category.key === itemCategory(item))
  // Always keep enabled first, then installed-but-disabled, then uninstalled catalog items.
  const tier = (item: PluginListItem) => item.plugin && !item.plugin.disabled ? 0 : isInstalled(item) ? 1 : 2
  const added = [...remaining.values()].sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || Number(itemBuiltin(b)) - Number(itemBuiltin(a))
    || itemName(a).localeCompare(itemName(b)) || a.key.localeCompare(b.key))
  const orderedInstalled = ordered.filter(isInstalled)
  const orderedUninstalled = ordered.filter(item => !isInstalled(item))
  const addedInstalled = added.filter(isInstalled)
  const addedUninstalled = added.filter(item => !isInstalled(item))
  return [...orderedInstalled, ...addedInstalled, ...orderedUninstalled, ...addedUninstalled]
}

export interface PluginJumpPlan {
  item: PluginListItem
  filters: PluginFilters
  page: number
}

/** Finds a plugin by package or entry name and returns the minimal filter adjustments + 1-based page needed to show it. */
export function planPluginJump(
  allItems: PluginListItem[],
  current: PluginFilters,
  targetName: string,
  pageSize: number,
): PluginJumpPlan | null {
  const target = allItems.find(item => itemName(item) === targetName || item.plugin?.name === targetName)
  if (!target) return null
  const next: PluginFilters = { ...current }
  if (next.installation === 'uninstalled' && isInstalled(target)) next.installation = 'all'
  else if (next.installation === 'installed' && !isInstalled(target)) next.installation = 'all'
  if (next.origin === 'builtin' && !itemBuiltin(target)) next.origin = 'all'
  else if (next.origin === 'third-party' && itemBuiltin(target)) next.origin = 'all'
  if (next.status === 'enabled' && (!target.plugin || target.plugin.disabled)) next.status = 'all'
  else if (next.status === 'disabled' && (!isInstalled(target) || (target.plugin && !target.plugin.disabled))) next.status = 'all'
  else if (next.status === 'attention' && !(target.plugin && needsAttention(target.plugin)) && !target.packageStatus?.error) next.status = 'all'
  if (next.category !== 'all' && itemCategory(target) !== next.category) next.category = 'all'
  if (next.updatesOnly && !target.updateInfo?.update) next.updatesOnly = false
  if (next.search.trim() && filterPluginItems([target], next).length === 0) next.search = ''
  const shown = filterPluginItems(allItems, next)
  const index = shown.findIndex(item => item.key === target.key)
  if (index < 0) return null
  return { item: target, filters: next, page: Math.floor(index / pageSize) + 1 }
}

export interface PluginFilters {
  installation: InstallationFilter
  category: CategoryKey | 'all'
  status: StatusFilter
  origin: OriginFilter
  search: string
  updatesOnly: boolean
}

export function filterPluginItems(items: PluginListItem[], filters: PluginFilters): PluginListItem[] {
  const query = filters.search.trim().toLocaleLowerCase()
  return items.filter(item => {
    if (filters.installation !== 'all' && isInstalled(item) !== (filters.installation === 'installed')) return false
    if (filters.category !== 'all' && itemCategory(item) !== filters.category) return false
    if (filters.origin === 'builtin' && !itemBuiltin(item)) return false
    if (filters.origin === 'third-party' && itemBuiltin(item)) return false
    if (filters.status === 'enabled' && (!item.plugin || item.plugin.disabled)) return false
    if (filters.status === 'disabled' && (!isInstalled(item) || (item.plugin && !item.plugin.disabled))) return false
    if (filters.status === 'attention' && !(item.plugin && needsAttention(item.plugin)) && !item.packageStatus?.error) return false
    if (filters.updatesOnly && !item.updateInfo?.update) return false
    if (query && ![itemTitle(item), itemName(item), item.plugin?.name,
      item.plugin ? pluginDescription(item.plugin) : item.catalog?.description ?? item.packageStatus?.description,
      item.plugin?.author?.name ?? item.catalog?.author?.name,
    ].some(value => value?.toLocaleLowerCase().includes(query))) return false
    return true
  })
}

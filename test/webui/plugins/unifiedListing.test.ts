import { describe, expect, it } from 'vitest'
import type { PluginCatalogItem, PluginCatalogState, PluginInstalledPackage } from '@luckylillia-dev/plugin-sdk/webui'
import type { CatalogSource } from '@/plugin/internal/service/webui/FE/components/plugins/catalog'
import {
  filterPluginItems, isInstalled, itemBuiltin, itemCategory, itemName, mergePluginItems, planPluginJump, type PluginFilters,
} from '@/plugin/internal/service/webui/FE/components/plugins/unifiedListing'
import type { PluginStatus } from '@/plugin/internal/service/webui/FE/types/plugins'

const filters: PluginFilters = { installation: 'all', category: 'all', status: 'all', origin: 'all', search: '', updatesOnly: false }

function plugin(name: string, overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    id: name, name, version: '1.0.0', manifest: {}, disabled: false, state: 'active',
    missingDeps: [], reloadCount: 0, service: { required: [], optional: [], implements: [] }, ...overrides,
  }
}

function entry(name: string, overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return { name, title: name, version: '2.0.0', ...overrides }
}

function installed(name: string, overrides: Partial<PluginInstalledPackage> = {}): PluginInstalledPackage {
  return { name, version: '1.0.0', managed: true, root: `data/plugins/${name}`, ...overrides }
}

function source(overrides: Partial<PluginCatalogState> = {}, key = 'market'): CatalogSource {
  return {
    key,
    state: {
      items: null, installed: null, updates: null, loading: false, checking: false, loadingInstalled: false,
      checkedAt: 0, busy: [], retry() {}, refresh() {},
      async install() { return true }, async update() { return true }, async uninstall() { return true },
      ...overrides,
    },
  }
}

describe('unified plugin list', () => {
  it('shows local entries while catalog data is unavailable', () => {
    const local = plugin('local-only', { disabled: true, state: 'disposed' })
    for (const sources of [[], [source({ loading: true })], [source({ error: 'offline' })]]) {
      const items = mergePluginItems([local], sources)
      expect(items).toHaveLength(1)
      expect(items[0].plugin).toBe(local)
      expect(filterPluginItems(items, { ...filters, installation: 'installed' })).toEqual(items)
      expect(filterPluginItems(items, { ...filters, installation: 'uninstalled' })).toEqual([])
    }
  })

  it.each([true, false])('matches builtin package names without adding a second card (packageName=%s)', withPackageName => {
    const packageName = '@luckylillia-dev/commands'
    const local = plugin('builtin:commands', { builtin: true, packageName: withPackageName ? packageName : undefined })
    const remote = entry(packageName, { builtin: local.name })
    const pkg = installed(packageName, { builtin: local.name })
    const market = source({ items: [remote], installed: [pkg], updates: { [packageName]: { update: '2.0.0' } } })
    const items = mergePluginItems([local], [market])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ plugin: local, catalog: remote, packageStatus: pkg, updateInfo: { update: '2.0.0' } })
    expect(itemName(items[0])).toBe(packageName)
    expect(itemBuiltin(items[0])).toBe(true)
  })

  it('keeps enabled instances first while sharing package metadata and update actions', () => {
    const first = plugin('multi', { id: 'b', state: 'pending' })
    const second = plugin('multi', { id: 'a', disabled: true, state: 'disposed' })
    const market = source({ items: [entry('multi')], installed: [installed('multi')], updates: { multi: { update: '2.0.0' } } })
    const items = mergePluginItems([second, first], [market])
    expect(items.map(item => item.key)).toEqual(['entry:b', 'entry:a'])
    expect(items.map(item => item.plugin)).toEqual([first, second])
    expect(items.every(item => item.source === market && item.updateInfo?.update === '2.0.0')).toBe(true)
    expect(filterPluginItems(items, { ...filters, installation: 'uninstalled' })).toEqual([])
  })

  it('updates toggle state in place and sorts by the latest state on a new visit', () => {
    const alpha = plugin('alpha')
    const beta = plugin('beta', { disabled: true, state: 'disposed' })
    const order = mergePluginItems([beta, alpha], []).map(item => item.key)
    const updated = [
      { ...beta, disabled: false, state: 'active' as const },
      { ...alpha, disabled: true, state: 'disposed' as const },
    ]
    const items = mergePluginItems(updated, [], order)
    expect(items.map(itemName)).toEqual(['alpha', 'beta'])
    expect(filterPluginItems(items, { ...filters, status: 'enabled' }).map(itemName)).toEqual(['beta'])
    expect(filterPluginItems(items, { ...filters, status: 'disabled' }).map(itemName)).toEqual(['alpha'])
    expect(mergePluginItems(updated, []).map(itemName)).toEqual(['beta', 'alpha'])
  })

  it('keeps existing positions when entries disappear or arrive during a visit', () => {
    const alpha = plugin('alpha')
    const beta = plugin('beta', { disabled: true })
    const order = mergePluginItems([alpha, beta, plugin('removed')], []).map(item => item.key)
    const items = mergePluginItems([plugin('new'), { ...beta, disabled: false }, { ...alpha, disabled: true }], [], order)
    expect(items.map(itemName)).toEqual(['alpha', 'beta', 'new'])
  })

  it('keeps an installed package without an entry and appends only uninstalled catalog packages', () => {
    const pkg = installed('broken', { error: 'missing entry point' })
    const market = source({ installed: [pkg], items: [entry('broken'), entry('new-plugin')] })
    const items = mergePluginItems([], [market])
    expect(items.map(item => [itemName(item), isInstalled(item)])).toEqual([['broken', true], ['new-plugin', false]])
    expect(filterPluginItems(items, { ...filters, status: 'attention' }).map(itemName)).toEqual(['broken'])
    expect(filterPluginItems(items, { ...filters, status: 'disabled' }).map(itemName)).toEqual(['broken'])
    expect(filterPluginItems(items, { ...filters, status: 'enabled' })).toEqual([])
  })

  it('deduplicates overlapping catalogs and uses the first provider for each package', () => {
    const first = source({ items: [entry('shared')], installed: [installed('shared')] }, 'first')
    const second = source({ items: [entry('shared', { version: '3.0.0' }), entry('extra')], installed: [installed('shared')] }, 'second')
    const items = mergePluginItems([], [first, second])
    expect(items).toHaveLength(2)
    expect(items.find(item => itemName(item) === 'shared')).toMatchObject({ catalog: { version: '2.0.0' }, source: first })
    expect(items.find(item => itemName(item) === 'extra')?.source).toBe(second)
  })

  it('removes stale catalog metadata and actions when its provider disappears, retaining local entries', () => {
    const local = plugin('local')
    const market = source({ items: [entry('local'), entry('remote')], installed: [installed('local')], updates: { local: { update: '2.0.0' } } })
    const before = mergePluginItems([local], [market])
    const after = mergePluginItems([local], [])
    expect(before).toHaveLength(2)
    expect(after).toHaveLength(1)
    expect(after[0].plugin).toBe(local)
    expect(after[0].catalog).toBeUndefined()
    expect(after[0].packageStatus).toBeUndefined()
    expect(after[0].source).toBeUndefined()
    expect(after[0].updateInfo).toBeUndefined()
    expect(before.find(item => itemName(item) === 'local')?.source).toBe(market)
  })

  it('combines installation, origin, category, status and update filters without showing unavailable updates', () => {
    const items = mergePluginItems([
      plugin('builtin:commands', { builtin: true, manifest: { category: 'service' } }),
      plugin('reply', { manifest: { category: 'chat' } }),
      plugin('paused', { disabled: true, state: 'disposed', manifest: { category: 'chat' } }),
    ], [source({
      installed: [installed('@luckylillia-dev/commands', { builtin: 'builtin:commands' }), installed('reply'), installed('paused')],
      items: [entry('fresh', { category: 'tool' }), entry('unknown', { category: 'custom' })],
      updates: { '@luckylillia-dev/commands': { update: '2.0.0' }, reply: { update: '2.0.0' }, paused: { latest: '2.0.0', blocked: 'SDK mismatch' } },
    })])
    const select = (patch: Partial<PluginFilters>) => filterPluginItems(items, { ...filters, ...patch }).map(itemName)
    expect(select({ installation: 'installed', origin: 'builtin', updatesOnly: true })).toEqual(['@luckylillia-dev/commands'])
    expect(select({ installation: 'installed', origin: 'third-party', category: 'chat', status: 'enabled', updatesOnly: true })).toEqual(['reply'])
    expect(select({ installation: 'installed', status: 'disabled' })).toEqual(['paused'])
    expect(select({ installation: 'uninstalled', origin: 'third-party', category: 'tool' })).toEqual(['fresh'])
    expect(select({ installation: 'uninstalled', updatesOnly: true })).toEqual([])
    expect(itemCategory(items.find(item => itemName(item) === 'unknown')!)).toBe('other')
  })

  it('searches local and catalog names, titles, descriptions and authors without case or surrounding whitespace', () => {
    const items = mergePluginItems([plugin('local-reply', {
      title: 'Local Responder', description: 'Replies to greetings', author: { name: 'Alice' },
    })], [source({ items: [entry('remote-tools', { title: 'Remote Toolbox', description: 'Compresses images', author: { name: 'Bob' } })] })])
    for (const query of ['LOCAL-REPLY', ' responder ', 'GREETINGS', 'alice']) {
      expect(filterPluginItems(items, { ...filters, search: query }).map(itemName)).toEqual(['local-reply'])
    }
    for (const query of ['REMOTE-TOOLS', ' toolbox ', 'IMAGES', 'bob']) {
      expect(filterPluginItems(items, { ...filters, search: query }).map(itemName)).toEqual(['remote-tools'])
    }
    expect(filterPluginItems(items, { ...filters, search: 'absent' })).toEqual([])
  })

  it('orders plugins as enabled, then installed-disabled, then uninstalled across categories', () => {
    const enabledTool = plugin('enabled-tool', { manifest: { category: 'tool' } })
    const disabledTool = plugin('disabled-tool', { disabled: true, state: 'disposed', manifest: { category: 'tool' } })
    const disabledChat = plugin('disabled-chat', { disabled: true, state: 'disposed', manifest: { category: 'chat' } })
    const market = source({
      installed: [installed('enabled-tool'), installed('disabled-tool'), installed('disabled-chat')],
      items: [
        entry('uninstalled-protocol', { category: 'protocol' }),
        entry('uninstalled-adapter', { category: 'adapter' }),
      ],
    })
    const items = mergePluginItems([disabledTool, enabledTool, disabledChat], [market])
    expect(items.map(itemName)).toEqual([
      'enabled-tool',
      'disabled-chat',
      'disabled-tool',
      'uninstalled-protocol',
      'uninstalled-adapter',
    ])
  })

  it('keeps newly installed plugins ahead of uninstalled catalog items even during an active visit', () => {
    const enabled = plugin('enabled-a', { manifest: { category: 'protocol' } })
    const disabled = plugin('disabled-a', { disabled: true, state: 'disposed', manifest: { category: 'tool' } })
    const beforeMarket = source({
      installed: [installed('enabled-a'), installed('disabled-a')],
      items: [entry('fresh-one', { category: 'adapter' }), entry('still-uninstalled', { category: 'protocol' })],
    })
    const visitOrder = mergePluginItems([enabled, disabled], [beforeMarket]).map(item => item.key)
    expect(visitOrder).toEqual(['entry:enabled-a', 'entry:disabled-a', 'catalog:still-uninstalled', 'catalog:fresh-one'])

    const newlyInstalled = plugin('fresh-one', { id: 'new-id', disabled: true, state: 'disposed', manifest: { category: 'adapter' } })
    const afterMarket = source({
      installed: [installed('enabled-a'), installed('disabled-a'), installed('fresh-one')],
      items: [entry('fresh-one', { category: 'adapter' }), entry('still-uninstalled', { category: 'protocol' })],
    })
    const after = mergePluginItems([enabled, disabled, newlyInstalled], [afterMarket], visitOrder)
    expect(after.map(itemName)).toEqual(['enabled-a', 'disabled-a', 'fresh-one', 'still-uninstalled'])
  })

  it('plans jump page and relaxes only conflicting filters so a newly installed plugin is visible', () => {
    const enabled = Array.from({ length: 12 }, (_, index) =>
      plugin(`enabled-${String(index).padStart(2, '0')}`, { manifest: { category: 'tool' } }),
    )
    const target = plugin('@luckylillia-dev/plugin-onebot11', {
      id: 'ob11', disabled: true, state: 'disposed', manifest: { category: 'adapter' }, title: 'OneBot 11',
    })
    const market = source({
      installed: [...enabled.map(p => installed(p.name)), installed(target.name)],
      items: [entry(target.name, { category: 'adapter', title: 'OneBot 11' }), entry('uninstalled-a', { category: 'chat' })],
    })
    const allItems = mergePluginItems([...enabled, target], [market])

    // Page 2 in unfiltered list (12 enabled items on page 1, target at index 12 -> page 2)
    const direct = planPluginJump(allItems, filters, target.name, 12)
    expect(direct?.item.key).toBe('entry:ob11')
    expect(direct?.page).toBe(2)
    expect(direct?.filters).toEqual(filters)

    // Installed from the 'uninstalled' tab with conflicting status/origin/category/search -> relaxes them
    const relaxed = planPluginJump(allItems, {
      installation: 'uninstalled',
      origin: 'builtin',
      status: 'enabled',
      category: 'protocol',
      search: 'something-else',
      updatesOnly: true,
    }, target.name, 12)
    expect(relaxed).toMatchObject({
      page: 2,
      filters: { installation: 'all', origin: 'all', status: 'all', category: 'all', search: '', updatesOnly: false },
    })

    // Compatible filters stay intact
    const preserved = planPluginJump(allItems, {
      installation: 'all',
      origin: 'third-party',
      status: 'disabled',
      category: 'adapter',
      search: 'onebot',
      updatesOnly: false,
    }, target.name, 12)
    expect(preserved).toMatchObject({
      page: 1,
      filters: { installation: 'all', origin: 'third-party', status: 'disabled', category: 'adapter', search: 'onebot', updatesOnly: false },
    })

    expect(planPluginJump(allItems, filters, 'missing-plugin', 12)).toBeNull()
  })
})

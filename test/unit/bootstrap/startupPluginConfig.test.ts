import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import Schema from 'schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PluginService, { type BuiltinPlugin } from '@/plugin/host'
import { startupPluginConfigs, startRequestedPlugins } from '@/main/startupPlugins'

let dir: string
let ctx: Context | undefined

function writePackage(root: string, name: string, source: string) {
  const pkgDir = path.join(root, ...name.split('/'))
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    llbot: { title: name },
  }))
  writeFileSync(path.join(pkgDir, 'index.js'), source)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llbot-cli-config-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('applying --plugin-config during startup', () => {
  it('configures and enables a disabled builtin with checkOnEnable and preserves untouched secrets', async () => {
    const started: unknown[] = []
    const qqBuiltin: BuiltinPlugin = {
      name: 'builtin:qq-official',
      title: 'QQ 官方机器人',
      config: {
        checkOnEnable: true,
        check(value, enabled) {
          if (enabled && (!value.appId || !value.secret)) return [{ path: ['appId'], message: '请先填写 AppID 和 Secret' }]
          return []
        },
      },
      plugin: {
        name: 'qq-official',
        Config: Schema.object({
          appId: Schema.string().default(''),
          secret: Schema.string().role('secret').default(''),
          sandbox: Schema.boolean().default(false),
        }),
        apply(_ctx: Context, config: unknown) {
          started.push(structuredClone(config))
        },
      },
      manifest: { category: 'protocol' },
    }

    const pluginsFile = path.join(dir, 'plugins.json')
    writeFileSync(pluginsFile, JSON.stringify({
      version: 1,
      entries: [{ id: 'qq000001', name: 'builtin:qq-official', disabled: true, config: { secret: 'stored-secret' } }],
    }))

    ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(PluginService, {
      file: pluginsFile,
      dataDir: path.join(dir, 'plugin-data'),
      roots: [path.join(dir, 'plugins')],
      builtins: [qqBuiltin],
      trust: true,
    })

    const configs = startupPluginConfigs([
      '--plugin-config', 'qq-official:appId=102000001',
      '--plugin-config', 'qq-official:sandbox=true',
    ])
    await startRequestedPlugins(ctx, [], undefined, configs)

    expect(started).toEqual([{ appId: '102000001', secret: 'stored-secret', sandbox: true }])
    const saved = JSON.parse(readFileSync(pluginsFile, 'utf8'))
    const entry = saved.entries.find((item: { name: string }) => item.name === 'builtin:qq-official')
    expect(entry.disabled).toBeUndefined()
    expect(entry.config).toEqual({ appId: '102000001', secret: 'stored-secret', sandbox: true })
  })

  it('auto-installs and configures a package before first start, applying early builtins (proxy) first', async () => {
    const order: string[] = []
    const appliedConfigs: unknown[] = []
    const root = path.join(dir, 'plugins')
    mkdirSync(root, { recursive: true })

    const proxyBuiltin: BuiltinPlugin = {
      name: 'builtin:proxy',
      title: '代理',
      config: {},
      plugin: {
        name: 'proxy',
        Config: Schema.object({ proxyAgent: Schema.string().default('') }),
        apply(_ctx: Context, config: { proxyAgent: string }) {
          order.push(`proxy:${config.proxyAgent}`)
        },
      },
      manifest: { category: 'service' },
    }

    const pluginsFile = path.join(dir, 'plugins.json')
    writeFileSync(pluginsFile, JSON.stringify({
      version: 1,
      entries: [{ id: 'prx00001', name: 'builtin:proxy', disabled: true }],
    }))

    ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(PluginService, {
      file: pluginsFile,
      dataDir: path.join(dir, 'plugin-data'),
      roots: [root],
      builtins: [proxyBuiltin],
      trust: true,
    })

    const pkgName = '@luckylillia-dev/plugin-onebot11'
    const installer = {
      ensureRequested: vi.fn(async (name: string) => {
        order.push(`install:${name}`)
        writePackage(root, pkgName, `
          import Schema from 'schemastery'
          export const name = 'onebot11'
          export const Config = Schema.object({
            port: Schema.natural().default(3000),
            token: Schema.string().default(''),
            enable: Schema.boolean().default(false),
          })
          export function apply(ctx, config) {
            globalThis.__testOnebotConfigs.push(config)
          }
        `)
        await ctx!.plugins.scan()
        return { names: [pkgName], installed: [] }
      }),
    }
    ;(globalThis as Record<string, unknown>).__testOnebotConfigs = appliedConfigs

    try {
      const configs = startupPluginConfigs([
        '--plugin-config', 'onebot11:port=6700',
        '--plugin-config', 'onebot11={"token":"my-token","enable":true}',
        '--plugin-config', 'proxy:proxyAgent=http://127.0.0.1:7890',
      ])
      await startRequestedPlugins(ctx, [], installer, configs)
    } finally {
      delete (globalThis as Record<string, unknown>).__testOnebotConfigs
    }

    // Proxy was configured & enabled before ensureRequested ran
    expect(order).toEqual(['proxy:http://127.0.0.1:7890', `install:${pkgName}`])
    // Package started once, already carrying its CLI configuration
    expect(appliedConfigs).toEqual([{ port: 6700, token: 'my-token', enable: true }])
    const saved = JSON.parse(readFileSync(path.join(dir, 'plugins.json'), 'utf8'))
    const entry = saved.entries.find((item: { name: string }) => item.name === pkgName)
    expect(entry.disabled).toBeUndefined()
    expect(entry.config).toEqual({ port: 6700, token: 'my-token', enable: true })
  })

  it('rejects unknown config fields cleanly without corrupting plugins.json', async () => {
    const satoriBuiltin: BuiltinPlugin = {
      name: 'builtin:satori',
      title: 'Satori',
      config: {},
      plugin: {
        name: 'satori',
        Config: Schema.object({
          port: Schema.natural().default(5500).description('监听端口'),
          token: Schema.string().default('').description('鉴权令牌'),
        }),
        apply() {},
      },
      manifest: { category: 'adapter' },
    }

    const pluginsFile = path.join(dir, 'plugins.json')
    writeFileSync(pluginsFile, JSON.stringify({
      version: 1,
      entries: [{ id: 'sat00001', name: 'builtin:satori', disabled: true }],
    }))
    ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(PluginService, {
      file: pluginsFile,
      dataDir: path.join(dir, 'plugin-data'),
      roots: [path.join(dir, 'plugins')],
      builtins: [satoriBuiltin],
      trust: true,
    })

    const configs = startupPluginConfigs(['--plugin-config', 'satori:prt=5500'])
    await expect(startRequestedPlugins(ctx, [], undefined, configs))
      .rejects.toThrow(/没有配置项「prt」.*port（监听端口）/)
    const status = ctx.plugins.list().find(item => item.name === 'builtin:satori')
    expect(status?.disabled).toBe(true)
  })
})

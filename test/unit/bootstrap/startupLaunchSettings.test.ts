import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import Schema from 'schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PluginService, { type BuiltinPlugin } from '@/plugin/host'
import {
  parsePluginConfigSpec,
  pluginLaunchSources,
  redactStartupArgv,
  startRequestedPlugins,
  startupLaunchSettings,
} from '@/main/startupPlugins'

const NT = '@luckylillia-dev/plugin-nt-protocol'
const OB = '@luckylillia-dev/plugin-onebot11'
const onebotLaunch = [
  { field: 'connect[type=ws].port', arg: '--onebot-ws-port', env: 'ONEBOT_WS_PORT', set: { 'connect[type=ws].enable': true } },
]
const sources = [
  {
    target: NT,
    launch: [
      { field: 'mode', arg: '--ntqq-mode', env: 'NTQQ_MODE', aliases: { native: 'nativeqq' } },
      { field: 'nativeQQ.qqPath', arg: '--ntqq-qq-path', env: 'NTQQ_QQ_PATH' },
      { field: 'protocol', env: 'NTQQ_PROTOCOL' },
    ],
  },
  { target: OB, launch: onebotLaunch },
]
const set = (plugin: string, fieldPath: string, raw: string) => ({ plugin, patch: { kind: 'set', path: fieldPath.split('.'), raw } })
const flags = (argv: string[], warn?: (message: string) => void) => startupLaunchSettings(sources, argv, warn, {})

describe('launch settings plugins declare (llbot.launch)', () => {
  it('turns both flag forms into settings in command-line order, with value aliases and extra fields', () => {
    expect(flags(['node', 'llbot.js', '--onebot-ws-port=3001', '--ntqq-mode', 'native', '--ntqq-qq-path=/opt/QQ/qq', '--other', 'x']))
      .toEqual([
        set(OB, 'connect[type=ws].port', '3001'),
        set(OB, 'connect[type=ws].enable', 'true'),
        set(NT, 'mode', 'nativeqq'),
        set(NT, 'nativeQQ.qqPath', '/opt/QQ/qq'),
      ])
  })

  it('passes a value without an alias as it is, and stops at --', () => {
    expect(flags(['--ntqq-mode=direct', '--', '--ntqq-mode=native'])).toEqual([set(NT, 'mode', 'direct')])
  })

  it('needs a value', () => {
    expect(() => flags(['--ntqq-mode'])).toThrow(/需要一个值/)
    expect(() => flags(['--ntqq-mode', '--dev'])).toThrow(/需要一个值/)
  })

  it('reads the variables before the flags so that a flag wins, and skips empty ones', () => {
    expect(startupLaunchSettings(sources, ['--ntqq-mode=direct'], undefined, {
      NTQQ_MODE: ' native ', NTQQ_QQ_PATH: '', NTQQ_PROTOCOL: 'macos', ONEBOT_WS_PORT: '3101',
    })).toEqual([
      set(NT, 'mode', 'nativeqq'),
      set(NT, 'protocol', 'macos'),
      set(OB, 'connect[type=ws].port', '3101'),
      set(OB, 'connect[type=ws].enable', 'true'),
      set(NT, 'mode', 'direct'),
    ])
  })

  it('only warns about a bad item or a name declared twice until it is used, and drops names that are not a plugin\'s', () => {
    const warn = vi.fn()
    const bad = [
      ...sources,
      {
        target: 'a',
        launch: [
          { field: 'x', arg: '--plugin-x' }, { field: 'x', arg: '--instance' }, { field: 'x', arg: '--Bad' },
          { arg: '--no-field' }, { field: 'x' }, { field: 'x', env: 'LLBOT_WEBUI_PORT' }, { field: 'x', env: 'PATH' },
        ],
      },
      { target: 'b', launch: [{ field: 'mode', arg: '--ntqq-mode', env: 'NTQQ_MODE' }] },
      { target: 'c', launch: { field: 'x' } },
    ]
    expect(startupLaunchSettings(bad, ['--ntqq-qq-path=/q', '--instance=x'], warn, { PATH: '/bin', LLBOT_WEBUI_PORT: '1' }))
      .toEqual([set(NT, 'nativeQQ.qqPath', '/q')])
    const warned = warn.mock.calls.map(call => call[0]).join('\n')
    for (const text of ['--plugin-x', '--instance', '--Bad', '--no-field', 'LLBOT_WEBUI_PORT', 'PATH', '参数 --ntqq-mode 同时由', '环境变量 NTQQ_MODE 同时由', 'c 的 llbot.launch 要是列表']) {
      expect(warned).toContain(text)
    }
    expect(() => startupLaunchSettings(bad, ['--ntqq-mode=direct'], undefined, {})).toThrow(/参数 --ntqq-mode 同时由 .*plugin-nt-protocol 和 b 声明/)
    expect(() => startupLaunchSettings(bad, [], undefined, { NTQQ_MODE: 'direct' })).toThrow(/环境变量 NTQQ_MODE 同时由/)
    expect(() => startupLaunchSettings(bad, ['--no-field=1'], undefined, {})).toThrow(/要用 field 写出/)
  })

  it('hides the values of flags that look secret in the startup log', () => {
    expect(redactStartupArgv(['--milky-token=abc', '--satori-token', 'abc', '--onebot-ws-port', '3001', '--plugin-config', 'x:connect[type=ws].token=abc']))
      .toEqual(['--milky-token=***', '--satori-token', '***', '--onebot-ws-port', '3001', '--plugin-config', 'x:connect[type=ws].token=***'])
  })

  it('lets --plugin-config pick a list item as well', () => {
    expect(parsePluginConfigSpec('onebot11:connect[type=ws].port=3001'))
      .toEqual({ plugin: 'onebot11', patch: { kind: 'set', path: ['connect[type=ws]', 'port'], raw: '3001' } })
  })
})

describe('applying launch settings at startup', () => {
  let dir: string
  let ctx: Context | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llbot-cli-launch-'))
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the settings of installed packages and builtins, and saves what they set', async () => {
    const root = path.join(dir, 'plugins')
    const pkgDir = path.join(root, '@luckylillia-dev', 'plugin-onebot11')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: OB,
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      llbot: { launch: onebotLaunch },
    }))
    writeFileSync(path.join(pkgDir, 'index.js'), `
      import Schema from 'schemastery'
      export const name = 'onebot11'
      export const Config = Schema.object({
        connect: Schema.array(Schema.union([
          Schema.object({ type: Schema.const('ws').required(), enable: Schema.boolean().default(false), port: Schema.natural().default(3001) }),
          Schema.object({ type: Schema.const('http').required(), enable: Schema.boolean().default(false), port: Schema.natural().default(3000) }),
        ])).default([]),
      })
      export function apply() {}
    `)
    const satori: BuiltinPlugin = {
      name: 'builtin:satori',
      title: 'Satori',
      config: {},
      plugin: { name: 'satori', Config: Schema.object({ port: Schema.natural().default(5600) }), apply() {} },
      manifest: { category: 'adapter', launch: [{ field: 'port', arg: '--satori-port', env: 'SATORI_PORT' }] },
    }
    const pluginsFile = path.join(dir, 'plugins.json')
    writeFileSync(pluginsFile, JSON.stringify({
      version: 1,
      entries: [
        { id: 'sat00001', name: 'builtin:satori', disabled: true },
        { id: 'ob110001', name: OB, disabled: true, config: { connect: [{ type: 'http', enable: true, port: 3000 }] } },
      ],
    }))
    ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(PluginService, {
      file: pluginsFile,
      dataDir: path.join(dir, 'plugin-data'),
      roots: [root],
      builtins: [satori],
      trust: true,
    })

    const configs = startupLaunchSettings(pluginLaunchSources(ctx), ['--onebot-ws-port', '3101'], undefined, { SATORI_PORT: '5700' })
    const installer = { ensureRequested: vi.fn(async (name: string) => ({ names: [name], installed: [] })) }
    await startRequestedPlugins(ctx, [], installer, configs)

    const saved = JSON.parse(readFileSync(pluginsFile, 'utf8'))
    const entry = (name: string) => saved.entries.find((item: { name: string }) => item.name === name)
    expect(entry('builtin:satori')).toMatchObject({ config: { port: 5700 } })
    expect(entry('builtin:satori').disabled).toBeUndefined()
    expect(entry(OB).config.connect).toEqual([{ type: 'http', enable: true, port: 3000 }, { type: 'ws', port: 3101, enable: true }])
    expect(entry(OB).disabled).toBeUndefined()
  })
})

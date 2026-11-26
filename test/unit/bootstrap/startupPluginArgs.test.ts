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
  pluginArgSources,
  redactStartupArgv,
  startRequestedPlugins,
  startupPluginArgs,
} from '@/main/startupPlugins'

const NT = '@luckylillia-dev/plugin-nt-protocol'
const OB = '@luckylillia-dev/plugin-onebot11'
const sources = [
  {
    target: NT,
    args: {
      '--ntqq-mode': { path: 'mode', values: { native: 'nativeqq' } },
      '--ntqq-qq-path': 'nativeQQ.qqPath',
    },
  },
  {
    target: OB,
    args: { '--onebot-ws-port': { path: 'connect[type=ws].port', set: { 'connect[type=ws].enable': true } } },
  },
]
const set = (plugin: string, fieldPath: string, raw: string) => ({ plugin, patch: { kind: 'set', path: fieldPath.split('.'), raw } })

describe('launch flags plugins declare (llbot.args)', () => {
  it('turns both forms into settings in command-line order, with value aliases and extra fields', () => {
    expect(startupPluginArgs(sources, [
      'node', 'llbot.js', '--onebot-ws-port=3001', '--ntqq-mode', 'native', '--ntqq-qq-path=/opt/QQ/qq', '--other', 'x',
    ])).toEqual([
      set(OB, 'connect[type=ws].port', '3001'),
      set(OB, 'connect[type=ws].enable', 'true'),
      set(NT, 'mode', 'nativeqq'),
      set(NT, 'nativeQQ.qqPath', '/opt/QQ/qq'),
    ])
  })

  it('passes a value without an alias as it is, and stops at --', () => {
    expect(startupPluginArgs(sources, ['--ntqq-mode=direct', '--', '--ntqq-mode=native'])).toEqual([set(NT, 'mode', 'direct')])
  })

  it('needs a value', () => {
    expect(() => startupPluginArgs(sources, ['--ntqq-mode'])).toThrow(/需要一个值/)
    expect(() => startupPluginArgs(sources, ['--ntqq-mode', '--dev'])).toThrow(/需要一个值/)
  })

  it('only warns about a bad declaration or a flag declared twice until the command line uses it', () => {
    const warn = vi.fn()
    const bad = [
      ...sources,
      { target: 'a', args: { '--plugin-x': 'x', '--instance': 'x', '--Bad': 'x', '--no-path': { values: {} } } },
      { target: 'b', args: { '--ntqq-mode': 'mode' } },
      { target: 'c', args: 'nope' },
    ]
    expect(startupPluginArgs(bad, ['--ntqq-qq-path=/q'], warn)).toEqual([set(NT, 'nativeQQ.qqPath', '/q')])
    expect(warn.mock.calls.map(call => call[0]).join('\n')).toMatch(
      /--plugin-x.*重名[\s\S]*--instance.*重名[\s\S]*--Bad[\s\S]*--no-path[\s\S]*--ntqq-mode 同时由[\s\S]*c 的 llbot\.args/,
    )
    expect(() => startupPluginArgs(bad, ['--ntqq-mode=direct'])).toThrow(/同时由 .*plugin-nt-protocol 和 b 声明/)
    expect(() => startupPluginArgs(bad, ['--instance=x'])).not.toThrow()
  })

  it('reads the variables plugins declare, before the flags so that a flag wins, and skips empty ones', () => {
    const withEnv = [
      { ...sources[0], env: { NTQQ_MODE: { path: 'mode', values: { native: 'nativeqq' } }, NTQQ_QQ_PATH: 'nativeQQ.qqPath' } },
      { target: 'builtin:satori', env: { SATORI_PORT: 'port' } },
    ]
    expect(startupPluginArgs(withEnv, ['--ntqq-mode=direct'], undefined, { NTQQ_MODE: ' native ', NTQQ_QQ_PATH: '', SATORI_PORT: '5700' }))
      .toEqual([set(NT, 'mode', 'nativeqq'), set('builtin:satori', 'port', '5700'), set(NT, 'mode', 'direct')])
  })

  it('keeps plugins off LLBot\'s, Node\'s and the system\'s variables', () => {
    const warn = vi.fn()
    const bad = [{ target: 'a', env: { LLBOT_WEBUI_PORT: 'port', NODE_OPTIONS: 'x', PATH: 'x', lower: 'x' } }]
    expect(startupPluginArgs(bad, [], warn, { LLBOT_WEBUI_PORT: '1', NODE_OPTIONS: '--x', PATH: '/bin', lower: 'x' })).toEqual([])
    expect(warn).toHaveBeenCalledTimes(4)
    const twice = [{ target: 'a', env: { SAME_NAME: 'x' } }, { target: 'b', env: { SAME_NAME: 'y' } }]
    expect(() => startupPluginArgs(twice, [], undefined, { SAME_NAME: '1' })).toThrow(/环境变量 SAME_NAME 同时由 a 和 b 声明/)
    expect(startupPluginArgs(twice, [], undefined, {})).toEqual([])
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

describe('applying launch flags at startup', () => {
  let dir: string
  let ctx: Context | undefined

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llbot-cli-args-'))
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the flags of installed packages and builtins, and saves what they set', async () => {
    const root = path.join(dir, 'plugins')
    const pkgDir = path.join(root, '@luckylillia-dev', 'plugin-onebot11')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: OB,
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      llbot: { args: sources[1].args },
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
      manifest: { category: 'adapter', args: { '--satori-port': 'port' } },
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

    const configs = startupPluginArgs(pluginArgSources(ctx), ['--satori-port=5700', '--onebot-ws-port', '3101'], undefined, {})
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

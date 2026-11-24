import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import {
  redactStartupArgv,
  resolvePluginConfigTarget,
  startupPluginConfigs,
  startupPluginError,
  startupPluginNames,
  startRequestedPlugins,
} from '@/main/startupPlugins'

describe('startup plugin arguments', () => {
  it('accepts scoped packages, repeated arguments, comma lists and deduplicates in input order', () => {
    expect(startupPluginNames(['node', 'llbot.js', '--plugin', '@luckylillia-dev/plugin-nt-protocol', '--plugin=a,b', '--plugin', ' b, @example/c ', '--plugin=a'])).toEqual([
      '@luckylillia-dev/plugin-nt-protocol', 'a', 'b', '@example/c',
    ])
  })
  it('leaves other arguments alone and respects the option terminator', () => {
    expect(startupPluginNames(['--plugin-dir', 'data/plugins', '--plugin-hmr', '--', '--plugin=ignored'])).toEqual([])
  })
  it.each(['', 'a,', ',a', 'a,,b', '@scope', '../local', 'file:local', 'https://example.com/p.tgz', 'name@1.0.0', '@scope/name@latest', 'a;whoami', 'a b', 'NAME', 'node_modules', 'favicon.ico', 'a'.repeat(215)])('rejects anything except package names: %s', value => {
    expect(() => startupPluginNames(['--plugin=' + value])).toThrow('--plugin')
  })
  it('rejects missing values and the next option instead of silently skipping the request', () => {
    expect(() => startupPluginNames(['--plugin'])).toThrow('--plugin')
    expect(() => startupPluginNames(['--plugin', '--instance=x'])).toThrow('--plugin')
  })
  it('does nothing without options, without accessing services or a registry', async () => {
    await expect(startRequestedPlugins({} as Context, [])).resolves.toBeUndefined()
  })
  it('redacts registry credentials and signed tarball queries from startup errors', () => {
    expect(startupPluginError(new Error('cannot download https://user:secret@example.com/p.tgz?token=hidden#fragment'))).toBe('cannot download https://example.com/p.tgz')
    expect(startupPluginError(new Error('cannot reach https://registry.npmmirror.com: ECONNREFUSED（经代理 http://127.0.0.1:7890，请检查代理设置）')))
      .toBe('cannot reach https://registry.npmmirror.com: ECONNREFUSED（经代理 http://127.0.0.1:7890，请检查代理设置）')
  })
})

describe('startup plugin config arguments', () => {
  it('parses path key-value pairs and JSON/JSON5 objects in both --plugin-config forms', () => {
    const configs = startupPluginConfigs([
      'node', 'llbot.js',
      '--plugin-config', 'qq-official:appId=102000001',
      '--plugin-config=builtin:proxy:proxyAgent=http://127.0.0.1:7890?a=1',
      '--plugin-config', 'onebot11:connect.0.url=ws://127.0.0.1:8080/ws',
      '--plugin-config', 'proxy:proxyAgent=',
      '--plugin-config', 'satori={"port":5500,"token":"abc"}',
      '--plugin-config=builtin:satori={port:5501,host:\'0.0.0.0\'}',
      '--plugin-config', 'lucky-lillia-plugin-blipreview:summary=true',
      '--',
      '--plugin-config', 'ignored:key=val',
    ])
    expect(configs).toEqual([
      { plugin: 'qq-official', patch: { kind: 'set', path: ['appId'], raw: '102000001' } },
      { plugin: 'builtin:proxy', patch: { kind: 'set', path: ['proxyAgent'], raw: 'http://127.0.0.1:7890?a=1' } },
      { plugin: 'onebot11', patch: { kind: 'set', path: ['connect', '0', 'url'], raw: 'ws://127.0.0.1:8080/ws' } },
      { plugin: 'proxy', patch: { kind: 'set', path: ['proxyAgent'], raw: '' } },
      { plugin: 'satori', patch: { kind: 'merge', value: { port: 5500, token: 'abc' } } },
      { plugin: 'builtin:satori', patch: { kind: 'merge', value: { port: 5501, host: '0.0.0.0' } } },
      { plugin: '@luckylillia-dev/plugin-blipreview', patch: { kind: 'set', path: ['summary'], raw: 'true' } },
    ])
  })

  it.each([
    'noequals',
    '=value',
    'qq-official:=123',
    'qq-official:.a=1',
    'qq-official:a..b=1',
    'qq-official:__proto__.x=1',
    'builtin:BAD:a=1',
    '../evil:a=1',
    'satori=[1,2,3]',
    'satori="string"',
    'satori={broken',
  ])('rejects invalid --plugin-config value: %s', value => {
    expect(() => startupPluginConfigs(['--plugin-config=' + value])).toThrow('--plugin-config')
  })

  it('rejects missing values after --plugin-config', () => {
    expect(() => startupPluginConfigs(['--plugin-config'])).toThrow('--plugin-config')
    expect(() => startupPluginConfigs(['--plugin-config', '--debug'])).toThrow('--plugin-config')
  })

  it('redacts config values from process.argv logs while keeping targets visible', () => {
    expect(redactStartupArgv([
      'node', 'llbot.js',
      '--plugin-config', 'qq-official:secret=super-secret',
      '--plugin-config=satori={"token":"my-token"}',
      '--plugin-config', 'builtin:proxy:proxyAgent=http://u:p@127.0.0.1:7890',
      '--debug',
      '--', '--plugin-config', 'untouched:a=b',
    ])).toEqual([
      'node', 'llbot.js',
      '--plugin-config', 'qq-official:secret=***',
      '--plugin-config=satori={...}',
      '--plugin-config', 'builtin:proxy:proxyAgent=***',
      '--debug',
      '--', '--plugin-config', 'untouched:a=b',
    ])
  })

  it('resolves friendly short names for builtins, official plugins and installed third-party packages', () => {
    const builtins = ['builtin:qq-official', 'builtin:proxy', 'builtin:satori', 'builtin:market']
    const known = ['@cindifind/java-bridge', '@luckylillia-dev/plugin-onebot11']

    expect(resolvePluginConfigTarget('qq-official', builtins, known)).toBe('builtin:qq-official')
    expect(resolvePluginConfigTarget('builtin:proxy', builtins, known)).toBe('builtin:proxy')
    expect(resolvePluginConfigTarget('onebot11', builtins, known)).toBe('@luckylillia-dev/plugin-onebot11')
    expect(resolvePluginConfigTarget('plugin-milky', builtins, known)).toBe('@luckylillia-dev/plugin-milky')
    expect(resolvePluginConfigTarget('telegram-protocol', builtins, known)).toBe('@luckylillia-dev/plugin-telegram-protocol')
    expect(resolvePluginConfigTarget('java-bridge', builtins, known)).toBe('@cindifind/java-bridge')
    expect(resolvePluginConfigTarget('unscoped-community-plugin', builtins, known)).toBe('unscoped-community-plugin')

    expect(() => resolvePluginConfigTarget('builtin:nonexistent', builtins, known)).toThrow(/可用内置插件/)
    expect(() => resolvePluginConfigTarget('helper', builtins, ['@a/plugin-helper', '@b/plugin-helper'])).toThrow(/匹配到多个插件/)
  })
})

import { describe, expect, it } from 'vitest'
import { splitArgs } from '@/main/manager/args'

describe('splitting the launch arguments between the manager and its instances', () => {
  it('keeps the WebUI port, the parent and the instance name for the manager', () => {
    const split = splitArgs(['--webui-port', '3081', '--parent-pid=42', '--instance', 'bot2', '--cdn', 'china'])
    expect(split.webuiPort).toBe(3081)
    expect(split.target).toEqual([])
    expect(split.shared).toEqual(['--cdn', 'china'])
  })

  it('reads the desktop app\'s arguments after --, and --webui-port=<p>', () => {
    const split = splitArgs(['--', '--parent-pid=1', '--instance', 'default', '--webui-port=4000', '--dev'])
    expect(split.webuiPort).toBe(4000)
    expect(split.shared).toEqual(['--dev'])
  })

  it('ignores a WebUI port that is not one', () => {
    expect(splitArgs(['--webui-port', 'abc']).webuiPort).toBeUndefined()
    expect(splitArgs(['--webui-port=70000']).webuiPort).toBeUndefined()
  })

  it('gives what names one account to the target instance only, values included', () => {
    const split = splitArgs([
      '-q', '123', '--protocol=macos', '--direct', '--nativeqq-config', 'c.json', '--qq-path', 'QQ.exe',
      '--plugin', '@a/b', '--plugin-config=qq-official:appId=1', '--dump-packets',
    ])
    expect(split.target).toEqual([
      '-q', '123', '--protocol=macos', '--direct', '--nativeqq-config', 'c.json', '--qq-path', 'QQ.exe',
      '--plugin', '@a/b', '--plugin-config=qq-official:appId=1', '--dump-packets',
    ])
    expect(split.shared).toEqual([])
  })

  it('gives every instance the rest, a plugin directory\'s value with it', () => {
    const split = splitArgs(['--plugin-dir', '../plugins', '--plugin-hmr', '--debug', '--plugin-dir=x'])
    expect(split.shared).toEqual(['--plugin-dir', '../plugins', '--plugin-hmr', '--debug', '--plugin-dir=x'])
  })
})

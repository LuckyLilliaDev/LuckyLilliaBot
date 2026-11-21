import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseCore, failedRuntimeDir, inContainer, readRelease, runtimeDir, setRuntimeAside } from '@/main/runtime'

let cwd: string
let installDir: string

function release(dir: string, version: string, extra: Record<string, unknown> = {}, files = ['llbot.js', 'llbot-core.js']) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@luckylillia-dev/luckylillia', version, ...extra }))
  for (const file of files) writeFileSync(path.join(dir, file), `${file} ${version}`)
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'llbot-runtime-'))
  installDir = path.join(cwd, 'image')
  release(installDir, '9.0.0', { name: 'llonebot-dist' })
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const choose = (env: NodeJS.ProcessEnv = {}, node = '24.13.0') => chooseCore({ installDir, cwd, env, node, container: true })
const own = () => path.join(installDir, 'llbot-core.js')

describe('container detection', () => {
  it('takes LLBOT_CONTAINER first, then the runtime markers', () => {
    const none = () => false
    expect(inContainer({ LLBOT_CONTAINER: '1' }, none)).toBe(true)
    expect(inContainer({ LLBOT_CONTAINER: '0' }, () => true)).toBe(false)
    expect(inContainer({}, file => file === '/.dockerenv')).toBe(true)
    expect(inContainer({}, file => file === '/run/.containerenv')).toBe(true)
    expect(inContainer({}, none)).toBe(false)
  })
})

describe('choosing the core to start', () => {
  it("starts the program's own outside a container, whatever is in the data volume", () => {
    release(runtimeDir(cwd), '9.1.0')
    expect(chooseCore({ installDir, cwd, env: {}, container: false })).toEqual({ core: own() })
    expect(existsSync(runtimeDir(cwd))).toBe(true)
  })

  it("starts the program's own when nothing is installed in the data volume", () => {
    expect(choose()).toEqual({ core: own() })
  })

  it('starts a newer release from the data volume', () => {
    release(runtimeDir(cwd), '9.1.0', { engines: { node: '>=22.15' } })
    const choice = choose()
    expect(choice.core).toBe(path.join(runtimeDir(cwd), 'llbot-core.js'))
    expect(choice.runtime).toMatchObject({ version: '9.1.0', node: '>=22.15' })
  })

  it.each(['9.0.0', '8.9.0'])('removes a release %s that a newer or equal image superseded', (version) => {
    release(runtimeDir(cwd), version)
    const choice = choose()
    expect(choice.core).toBe(own())
    expect(choice.note).toContain('已删除')
    expect(existsSync(runtimeDir(cwd))).toBe(false)
  })

  it('keeps but skips a release that needs a newer Node.js', () => {
    release(runtimeDir(cwd), '9.1.0', { engines: { node: '>=99' } })
    const choice = choose()
    expect(choice.core).toBe(own())
    expect(choice.note).toContain('需要 Node.js >=99')
    expect(existsSync(runtimeDir(cwd))).toBe(true)
  })

  it('keeps but skips a release that is not whole', () => {
    release(runtimeDir(cwd), '9.1.0', {}, ['llbot.js'])
    expect(choose()).toMatchObject({ core: own(), note: expect.stringContaining('不是完整的发布包') })
    expect(existsSync(runtimeDir(cwd))).toBe(true)
  })

  it('leaves an installed release alone when LLBOT_SELF_UPDATE=0', () => {
    release(runtimeDir(cwd), '9.1.0')
    expect(choose({ LLBOT_SELF_UPDATE: '0' })).toMatchObject({ core: own(), note: expect.stringContaining('LLBOT_SELF_UPDATE=0') })
    expect(existsSync(runtimeDir(cwd))).toBe(true)
  })
})

describe('setting a failed release aside', () => {
  it('moves it next to the data volume runtime, replacing one set aside before', () => {
    release(failedRuntimeDir(cwd), '9.0.5')
    release(runtimeDir(cwd), '9.1.0')
    expect(setRuntimeAside(cwd)).toBe(failedRuntimeDir(cwd))
    expect(existsSync(runtimeDir(cwd))).toBe(false)
    expect(readFileSync(path.join(failedRuntimeDir(cwd), 'llbot-core.js'), 'utf8')).toBe('llbot-core.js 9.1.0')
    expect(readRelease(failedRuntimeDir(cwd))?.version).toBe('9.1.0')
  })
})

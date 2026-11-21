import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_PACKAGE, CoreUpdater, createCoreUpdateRoutes, replaceInstall, WORK_DIR } from '@/main/coreUpdate'
import { RegistryError, type PackageVersion, type Packument, type RegistryClient } from '@/plugin/internal/tool/market/registry'

type Files = Record<string, string>

function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0)
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(size.toString(8).padStart(11, '0') + '\0', 124)
  block.write('00000000000\0', 136)
  block.write('        ', 148)
  block.write('0', 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return block
}

/** An npm tarball: every file under package/ */
function tarball(files: Files): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    blocks.push(header(`package/${name}`, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

interface Release { files: Files; engines?: Record<string, string> }

/** A registry in memory with the given releases of the core package; `latest` tags one of them */
function fakeRegistry(releases: Record<string, Release>, latest?: string) {
  const downloads: string[] = []
  const client: RegistryClient = {
    async packument(name) {
      if (name !== CORE_PACKAGE || !latest) throw new RegistryError(`package ${name} not found`, 404)
      const versions = Object.fromEntries(Object.entries(releases).map(([version, release]) => [version, {
        name: CORE_PACKAGE, version, engines: release.engines, dist: { tarball: `mem://${version}` },
      } as PackageVersion]))
      return { name, 'dist-tags': { latest }, versions } as Packument
    },
    async tarball(version) {
      downloads.push(version.version)
      return tarball(releases[version.version].files)
    },
  }
  return { client, downloads }
}

const release = (version: string, extra: Files = {}): Release => ({
  files: {
    'package.json': JSON.stringify({ name: CORE_PACKAGE, version }),
    'llbot.js': `supervisor ${version}`,
    'llbot-core.js': `core ${version}`,
    'node_modules/a/index.js': `a ${version}`,
    'webui/index.html': `webui ${version}`,
    'chunks/shared.js': `chunk ${version}`,
    ...extra,
  },
})

let installDir: string

function write(file: string, content: string) {
  mkdirSync(path.dirname(path.join(installDir, file)), { recursive: true })
  writeFileSync(path.join(installDir, file), content)
}
const read = (file: string) => readFileSync(path.join(installDir, file), 'utf8')

beforeEach(() => {
  installDir = mkdtempSync(path.join(tmpdir(), 'llbot-install-'))
  write('package.json', JSON.stringify({ name: 'llonebot-dist', version: '9.0.0' }))
  write('llbot.js', 'supervisor 9.0.0')
  write('llbot-core.js', 'core 9.0.0')
  write('node_modules/a/index.js', 'a 9.0.0')
  write('node_modules/stale/index.js', 'only in 9.0.0')
  write('webui/index.html', 'webui 9.0.0')
  write('使用说明.txt', 'readme 9.0.0')
  write('node.exe', 'bundled node')
  write('data/instances/default/plugins.json', 'user settings')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(installDir, { recursive: true, force: true })
})

function updater(registry: RegistryClient, options: Partial<ConstructorParameters<typeof CoreUpdater>[0]> = {}) {
  return new CoreUpdater({
    installDir, current: '9.0.0', registry: () => registry, blocker: async () => undefined,
    restart: () => true, restartDelay: 0, nodeVersion: '24.13.0', ...options,
  })
}

describe('checking for a new version', () => {
  it('reports a newer release as available', async () => {
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const status = await updater(client).check()
    expect(status).toMatchObject({ current: '9.0.0', latest: '9.1.0', available: true, state: 'idle' })
    expect(status.error).toBeUndefined()
    expect(status.checkedAt).toBeTypeOf('number')
  })

  it('reports nothing to do when the running version is the latest', async () => {
    const { client } = fakeRegistry({ '9.0.0': release('9.0.0') }, '9.0.0')
    expect(await updater(client).check()).toMatchObject({ latest: '9.0.0', available: false })
  })

  it('checks the Node.js version a release needs, partial versions included', async () => {
    const { client } = fakeRegistry({
      '9.1.0': { ...release('9.1.0'), engines: { node: '>=22.15' } },
      '9.2.0': { ...release('9.2.0'), engines: { node: '>=99' } },
    }, '9.1.0')
    expect(await updater(client).check()).toMatchObject({ available: true })
    const { client: newer } = fakeRegistry({ '9.2.0': { ...release('9.2.0'), engines: { node: '>=99' } } }, '9.2.0')
    const status = await updater(newer).check()
    expect(status.available).toBe(false)
    expect(status.incompatible).toContain('Node.js >=99')
  })

  it('says so when the package is not on npm yet', async () => {
    const { client } = fakeRegistry({})
    const status = await updater(client).check()
    expect(status).toMatchObject({ available: false, latest: undefined })
    expect(status.error).toBe(`npm 上还没有 ${CORE_PACKAGE}`)
  })

  it('reports why this installation cannot update itself', async () => {
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const status = await updater(client, { blocker: async () => '从源码运行时不能自动更新' }).check()
    expect(status).toMatchObject({ latest: '9.1.0', available: false, blocked: '从源码运行时不能自动更新' })
  })
})

describe('updating', () => {
  it('replaces what the package carries, keeps the rest, backs up the old files and restarts', async () => {
    vi.useFakeTimers()
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0', { 'data/from-package.txt': 'must not land' }) }, '9.1.0')
    const restart = vi.fn(() => true)
    const status = await updater(client, { restart }).update('9.1.0')
    expect(status.state).toBe('restarting')

    expect(read('llbot.js')).toBe('supervisor 9.1.0')
    expect(read('llbot-core.js')).toBe('core 9.1.0')
    expect(read('node_modules/a/index.js')).toBe('a 9.1.0')
    expect(read('webui/index.html')).toBe('webui 9.1.0')
    expect(read('chunks/shared.js')).toBe('chunk 9.1.0')
    expect(JSON.parse(read('package.json'))).toEqual({ name: CORE_PACKAGE, version: '9.1.0' })
    // A replaced directory is the package's, nothing left of the old one
    expect(existsSync(path.join(installDir, 'node_modules/stale'))).toBe(false)
    // Not in the package: untouched
    expect(read('使用说明.txt')).toBe('readme 9.0.0')
    expect(read('node.exe')).toBe('bundled node')
    expect(read('data/instances/default/plugins.json')).toBe('user settings')
    expect(existsSync(path.join(installDir, 'data/from-package.txt'))).toBe(false)

    const backup = path.join(installDir, WORK_DIR, 'backup-9.0.0')
    expect(readFileSync(path.join(backup, 'llbot-core.js'), 'utf8')).toBe('core 9.0.0')
    expect(readFileSync(path.join(backup, 'node_modules/stale/index.js'), 'utf8')).toBe('only in 9.0.0')
    expect(readdirSync(path.join(installDir, WORK_DIR))).toEqual(['backup-9.0.0'])

    expect(restart).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(restart).toHaveBeenCalledOnce()
  })

  it('takes a version the first registry lacks from the next one through `need`', async () => {
    vi.useFakeTimers()
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const packument = vi.spyOn(client, 'packument')
    await updater(client).update('9.1.0')
    const need = packument.mock.calls[0][2]!
    expect(need({ name: CORE_PACKAGE, 'dist-tags': {}, versions: {} })).toBe(false)
    expect(need({ name: CORE_PACKAGE, 'dist-tags': {}, versions: { '9.1.0': {} as PackageVersion } })).toBe(true)
  })

  it('refuses while blocked, without downloading anything', async () => {
    const { client, downloads } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const update = updater(client, { blocker: async () => '实例 b 也在用这份程序运行，请先停止它们再更新' }).update('9.1.0')
    await expect(update).rejects.toMatchObject({ status: 409, message: expect.stringContaining('实例 b') })
    expect(downloads).toEqual([])
    expect(read('llbot-core.js')).toBe('core 9.0.0')
  })

  it.each([
    ['9.0.0', '不比正在运行的'],
    ['8.9.0', '不比正在运行的'],
    ['latest', '完整的版本号'],
  ])('refuses %s', async (version, message) => {
    const { client, downloads } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    await expect(updater(client).update(version)).rejects.toThrow(message)
    expect(downloads).toEqual([])
  })

  it('leaves the installation as it was when the package is not a whole release', async () => {
    const broken = release('9.1.0')
    delete broken.files['llbot-core.js']
    const { client } = fakeRegistry({ '9.1.0': broken }, '9.1.0')
    const update = updater(client)
    await expect(update.update('9.1.0')).rejects.toThrow('缺少 llbot-core.js')
    expect(read('llbot.js')).toBe('supervisor 9.0.0')
    expect(read('node_modules/stale/index.js')).toBe('only in 9.0.0')
    expect(readdirSync(path.join(installDir, WORK_DIR))).toEqual([])
    expect(update.status()).toMatchObject({ state: 'idle', error: expect.stringContaining('llbot-core.js') })
  })

  it('refuses a package whose manifest names another version', async () => {
    const mismatched = release('9.1.0')
    mismatched.files['package.json'] = JSON.stringify({ name: CORE_PACKAGE, version: '9.0.5' })
    const { client } = fakeRegistry({ '9.1.0': mismatched }, '9.1.0')
    await expect(updater(client).update('9.1.0')).rejects.toThrow('包名或版本')
    expect(read('llbot-core.js')).toBe('core 9.0.0')
  })
})

describe('replacing the installation', () => {
  it('moves everything back when one move fails', async () => {
    const staged = path.join(installDir, WORK_DIR, 'staging')
    const backup = path.join(installDir, WORK_DIR, 'backup')
    mkdirSync(path.join(staged, 'node_modules/a'), { recursive: true })
    mkdirSync(path.join(staged, 'webui'), { recursive: true })
    mkdirSync(backup, { recursive: true })
    writeFileSync(path.join(staged, 'llbot.js'), 'new')
    writeFileSync(path.join(staged, 'node_modules/a/index.js'), 'new a')
    writeFileSync(path.join(staged, 'webui/index.html'), 'new webui')
    const ops = {
      rename: vi.fn(async (from: string, to: string) => {
        // Placing the new webui fails, after the old one was moved aside
        if (from === path.join(staged, 'webui')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await rename(from, to)
      }),
    }
    await expect(replaceInstall(installDir, staged, backup, ops)).rejects.toThrow('有文件正被占用')
    expect(read('llbot.js')).toBe('supervisor 9.0.0')
    expect(read('node_modules/a/index.js')).toBe('a 9.0.0')
    expect(read('node_modules/stale/index.js')).toBe('only in 9.0.0')
    expect(read('webui/index.html')).toBe('webui 9.0.0')
    expect(readFileSync(path.join(staged, 'llbot.js'), 'utf8')).toBe('new')
    expect(readdirSync(backup)).toEqual([])
  })
})

describe('cleaning up', () => {
  it('removes interrupted downloads and keeps only the newest backup', async () => {
    const work = path.join(installDir, WORK_DIR)
    for (const [name, age] of [['backup-8.0.0', 300], ['backup-8.5.0', 200], ['backup-9.0.0', 100], ['staging-9.1.0', 0]] as const) {
      mkdirSync(path.join(work, name), { recursive: true })
      const time = new Date(Date.now() - age * 1000)
      utimesSync(path.join(work, name), time, time)
    }
    const { client } = fakeRegistry({})
    await updater(client).cleanup()
    expect(readdirSync(work)).toEqual(['backup-9.0.0'])
  })
})

describe('the WebUI routes', () => {
  it('answers status, check and update, with the reason when an update is refused', async () => {
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const routes = createCoreUpdateRoutes(updater(client, { blocker: async () => '在容器中运行时请更新镜像，不能自动更新' }))
    const json = async (response: Response | Promise<Response>) => {
      const res = await response
      return { status: res.status, body: await res.json() as { success: boolean; data?: Record<string, unknown>; message?: string } }
    }
    expect((await json(routes.request('/status'))).body.data).toMatchObject({ current: '9.0.0', state: 'idle' })
    expect((await json(routes.request('/check', { method: 'POST' }))).body.data).toMatchObject({ latest: '9.1.0', available: false })
    const refused = await json(routes.request('/update', { method: 'POST', body: JSON.stringify({ version: '9.1.0' }), headers: { 'content-type': 'application/json' } }))
    expect(refused).toEqual({ status: 409, body: { success: false, message: '在容器中运行时请更新镜像，不能自动更新' } })
  })
})

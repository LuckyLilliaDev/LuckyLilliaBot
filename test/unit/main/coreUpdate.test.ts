import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_PACKAGE, CoreUpdater, createCoreUpdateRoutes, GITHUB_REPO, releasePageUrl, replaceInstall, scheduleAutoCheck, updateBlocker, WORK_DIR } from '@/main/coreUpdate'
import { failedRuntimeDir, runtimeDir } from '@/main/runtime'
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
  vi.unstubAllEnvs()
  rmSync(installDir, { recursive: true, force: true })
})

function updater(registry: RegistryClient, options: Partial<ConstructorParameters<typeof CoreUpdater>[0]> = {}) {
  return new CoreUpdater({
    installDir, current: '9.0.0', registry: () => registry, blocker: async () => undefined,
    restart: () => true, restartDelay: 0, nodeVersion: '24.13.0', container: false, cwd: installDir, ...options,
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
    expect(readdirSync(path.join(installDir, WORK_DIR)).sort()).toEqual(['backup-9.0.0', 'installed-files.json'])
    expect(JSON.parse(readFileSync(path.join(installDir, WORK_DIR, 'installed-files.json'), 'utf8'))).toEqual(
      expect.arrayContaining(['llbot.js', 'llbot-core.js', 'node_modules', 'webui', 'chunks', 'package.json']),
    )

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

  it('moves removed release entries like llbot-manager.js into backup while leaving non-release files untouched', async () => {
    const staged = path.join(installDir, WORK_DIR, 'staging')
    const backup = path.join(installDir, WORK_DIR, 'backup')
    mkdirSync(staged, { recursive: true })
    mkdirSync(backup, { recursive: true })
    write('llbot-manager.js', 'old manager')
    write('node.exe', 'bundled runtime')
    writeFileSync(path.join(staged, 'llbot.js'), 'new supervisor')
    writeFileSync(path.join(staged, 'llbot-core.js'), 'new core')

    await replaceInstall(installDir, staged, backup)
    expect(existsSync(path.join(installDir, 'llbot-manager.js'))).toBe(false)
    expect(readFileSync(path.join(backup, 'llbot-manager.js'), 'utf8')).toBe('old manager')
    expect(read('node.exe')).toBe('bundled runtime')
    expect(read('llbot.js')).toBe('new supervisor')
  })

  it('restores removed stale entries when a subsequent move fails', async () => {
    const staged = path.join(installDir, WORK_DIR, 'staging')
    const backup = path.join(installDir, WORK_DIR, 'backup')
    mkdirSync(staged, { recursive: true })
    mkdirSync(backup, { recursive: true })
    write('llbot-manager.js', 'old manager')
    writeFileSync(path.join(staged, 'llbot.js'), 'new supervisor')
    writeFileSync(path.join(staged, 'llbot-core.js'), 'new core')

    const ops = {
      rename: vi.fn(async (from: string, to: string) => {
        if (from === path.join(installDir, 'llbot-core.js')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await rename(from, to)
      }),
    }
    await expect(replaceInstall(installDir, staged, backup, ops)).rejects.toThrow('已还原为原来的版本')
    expect(read('llbot-manager.js')).toBe('old manager')
    expect(read('llbot.js')).toBe('supervisor 9.0.0')
    expect(read('llbot-core.js')).toBe('core 9.0.0')
    expect(readdirSync(backup)).toEqual([])
  })

  it('uses installed-files.json to clean up custom release entries removed in a later update', async () => {
    const staged1 = path.join(installDir, WORK_DIR, 'staging-1')
    const backup1 = path.join(installDir, WORK_DIR, 'backup-1')
    mkdirSync(staged1, { recursive: true })
    mkdirSync(backup1, { recursive: true })
    writeFileSync(path.join(staged1, 'llbot.js'), 'v1')
    writeFileSync(path.join(staged1, 'custom-extra.js'), 'extra v1')
    await replaceInstall(installDir, staged1, backup1)
    expect(read('custom-extra.js')).toBe('extra v1')

    const staged2 = path.join(installDir, WORK_DIR, 'staging-2')
    const backup2 = path.join(installDir, WORK_DIR, 'backup-2')
    mkdirSync(staged2, { recursive: true })
    mkdirSync(backup2, { recursive: true })
    writeFileSync(path.join(staged2, 'llbot.js'), 'v2')
    await replaceInstall(installDir, staged2, backup2)
    expect(existsSync(path.join(installDir, 'custom-extra.js'))).toBe(false)
    expect(readFileSync(path.join(backup2, 'custom-extra.js'), 'utf8')).toBe('extra v1')
  })
})

describe('cleaning up', () => {
  it('removes interrupted downloads, keeps only the newest backup, and preserves installed-files.json', async () => {
    const work = path.join(installDir, WORK_DIR)
    for (const [name, age] of [['backup-8.0.0', 300], ['backup-8.5.0', 200], ['backup-9.0.0', 100], ['staging-9.1.0', 0]] as const) {
      mkdirSync(path.join(work, name), { recursive: true })
      const time = new Date(Date.now() - age * 1000)
      utimesSync(path.join(work, name), time, time)
    }
    writeFileSync(path.join(work, 'installed-files.json'), '["llbot.js"]\n')
    const { client } = fakeRegistry({})
    await updater(client).cleanup()
    expect(readdirSync(work).sort()).toEqual(['backup-9.0.0', 'installed-files.json'])
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

describe('updating in a container', () => {
  it('installs the whole release into the data volume and leaves the image files alone', async () => {
    vi.useFakeTimers()
    // An older self-installed release, and one set aside after failing to start
    write('data/llbot-runtime/package.json', JSON.stringify({ name: CORE_PACKAGE, version: '9.0.5' }))
    write('data/llbot-runtime/only-in-9.0.5.txt', 'old')
    write('data/llbot-runtime.failed/llbot-core.js', 'broken')
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const restart = vi.fn(() => true)
    expect((await updater(client, { container: true, restart }).update('9.1.0')).state).toBe('restarting')

    const runtime = runtimeDir(installDir)
    expect(readFileSync(path.join(runtime, 'llbot-core.js'), 'utf8')).toBe('core 9.1.0')
    expect(readFileSync(path.join(runtime, 'node_modules/a/index.js'), 'utf8')).toBe('a 9.1.0')
    expect(existsSync(path.join(runtime, 'only-in-9.0.5.txt'))).toBe(false)
    expect(existsSync(failedRuntimeDir(installDir))).toBe(false)
    // The image's files: untouched, no backup next to them
    expect(read('llbot-core.js')).toBe('core 9.0.0')
    expect(read('node_modules/stale/index.js')).toBe('only in 9.0.0')
    expect(existsSync(path.join(installDir, WORK_DIR))).toBe(false)
    expect(read('data/instances/default/plugins.json')).toBe('user settings')
    expect(readdirSync(path.join(installDir, 'data')).sort()).toEqual(['instances', 'llbot-runtime'])
    await vi.runAllTimersAsync()
    expect(restart).toHaveBeenCalledOnce()
  })

  it('removes what an interrupted container update left in the data directory', async () => {
    write('data/llbot-runtime.staging-9.1.0/llbot.js', 'half')
    write('data/llbot-runtime.old/llbot.js', 'previous')
    write('data/llbot-runtime/llbot.js', 'current')
    const { client } = fakeRegistry({})
    await updater(client, { container: true }).cleanup()
    expect(readdirSync(path.join(installDir, 'data')).sort()).toEqual(['instances', 'llbot-runtime'])
  })
})

describe('what blocks an update', () => {
  it('refuses a source tree', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'llbot-source-'))
    try {
      expect(await updateBlocker(source)).toBe('从源码运行时不能自动更新')
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })
})

describe('GitHub release notes', () => {
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })

  it('fetches release notes for v<version> and caches them', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v9.1.0`)
      return jsonResponse({
        name: 'v9.1.0 - Spring Update',
        body: '## Changes\n- Better updates',
        html_url: 'https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/v9.1.0',
        published_at: '2026-11-22T00:00:00Z',
      })
    })
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const core = updater(client, { fetch })
    const first = await core.releaseNotes('9.1.0')
    const second = await core.releaseNotes('9.1.0')
    expect(first).toEqual({
      version: '9.1.0',
      title: 'v9.1.0 - Spring Update',
      body: '## Changes\n- Better updates',
      url: releasePageUrl('9.1.0'),
      publishedAt: '2026-11-22T00:00:00Z',
    })
    expect(second).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bare tag when v<version> is 404', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/tags/v9.1.0')) return jsonResponse({ message: 'Not Found' }, 404)
      return jsonResponse({ name: '', body: 'notes', html_url: 'https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/9.1.0' })
    })
    const { client } = fakeRegistry({})
    const notes = await updater(client, { fetch }).releaseNotes('9.1.0')
    expect(notes).toMatchObject({ version: '9.1.0', title: 'v9.1.0', body: 'notes', url: 'https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/9.1.0' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports 404, rate limits, network failures and invalid versions clearly', async () => {
    const { client } = fakeRegistry({})
    const notFound = vi.fn(async () => jsonResponse({}, 404))
    await expect(updater(client, { fetch: notFound }).releaseNotes('9.1.0')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('v9.1.0') })

    const rateLimited = vi.fn(async () => jsonResponse({}, 403))
    await expect(updater(client, { fetch: rateLimited }).releaseNotes('9.1.0')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('受限') })

    const offline = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(updater(client, { fetch: offline }).releaseNotes('9.1.0')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('ECONNRESET') })

    await expect(updater(client, { fetch: notFound }).releaseNotes('latest')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('完整的版本号') })
  })

  it('serves /release-notes for an explicit version or the latest checked version', async () => {
    const fetch = vi.fn(async () => jsonResponse({ name: 'v9.1.0', body: 'hello', html_url: releasePageUrl('9.1.0') }))
    const { client } = fakeRegistry({ '9.1.0': release('9.1.0') }, '9.1.0')
    const core = updater(client, { fetch })
    const routes = createCoreUpdateRoutes(core)
    await core.check()

    const implicit = await routes.request('/release-notes')
    expect(implicit.status).toBe(200)
    expect(await implicit.json()).toMatchObject({ success: true, data: { version: '9.1.0', body: 'hello' } })

    const explicit = await routes.request('/release-notes?version=9.1.0')
    expect(explicit.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('background auto-check', () => {
  it('checks after the initial delay, repeats on schedule, announces each version once and stops on dispose', async () => {
    vi.useFakeTimers()
    let currentLatest = '9.1.0'
    const releases: Record<string, Release> = { '9.1.0': release('9.1.0'), '9.2.0': release('9.2.0') }
    const packument = vi.fn(async () => ({
      name: CORE_PACKAGE,
      'dist-tags': { latest: currentLatest },
      versions: Object.fromEntries(Object.entries(releases).map(([version]) => [version, {
        name: CORE_PACKAGE, version, dist: { tarball: `mem://${version}` },
      } as PackageVersion])),
    } as Packument))
    const client: RegistryClient = { packument, tarball: async () => Buffer.alloc(0) }
    const log = { info: vi.fn(), warn: vi.fn() }
    const core = updater(client, { log })
    const stop = scheduleAutoCheck(core, { delay: 1000, interval: 5000, log })

    expect(packument).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(packument).toHaveBeenCalledTimes(1)
    expect(core.status()).toMatchObject({ latest: '9.1.0', available: true })
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('9.1.0'))

    // Same version again: checks, but does not repeat the log line
    await vi.advanceTimersByTimeAsync(5000)
    expect(packument).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenCalledTimes(1)

    // Newer version published: logs once more
    currentLatest = '9.2.0'
    await vi.advanceTimersByTimeAsync(5000)
    expect(packument).toHaveBeenCalledTimes(3)
    expect(core.status().latest).toBe('9.2.0')
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenLastCalledWith(expect.stringContaining('9.2.0'))

    stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(packument).toHaveBeenCalledTimes(3)
  })

  it('does not leave a background failure in status.error', async () => {
    const { client } = fakeRegistry({})
    const core = updater(client)
    const status = await core.check({ background: true })
    expect(status.error).toBeUndefined()
    expect(status.available).toBe(false)
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreUpdater, installDirOf, updateBlocker } from '@/main/coreUpdate'
import { GatewayAuth, hashPassword } from '@/main/manager/auth'
import { consumeResumeInstances, createCoreUpdateHandler, managerRegistries, saveResumeInstances } from '@/main/manager/coreUpdateHandler'
import { Gateway } from '@/main/manager/gateway'
import type { Packument, RegistryClient } from '@/plugin/internal/tool/market/registry'

/** Minimal ustar tarball matching what CoreUpdater.update() expects */
function tarGz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(`package/${name}`, 0, 100)
    header.write('0000644\0', 100, 8)
    header.write('0000000\0', 108, 8)
    header.write('0000000\0', 116, 8)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12)
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12)
    header.fill(0x20, 148, 156)
    header.write('0', 156, 1)
    header.write('ustar\0', 257, 6)
    header.write('00', 263, 2)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(header, data)
    const rem = data.length % 512
    if (rem) blocks.push(Buffer.alloc(512 - rem))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function fakeRegistry(version: string, archive: Buffer): RegistryClient {
  const doc: Packument = {
    name: '@luckylillia-dev/luckylillia',
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: '@luckylillia-dev/luckylillia',
        version,
        dist: { tarball: `https://example.invalid/${version}.tgz` },
      },
    },
  }
  return {
    packument: async () => doc,
    tarball: async () => archive,
  }
}

let dir: string
let installDir: string
let stateDir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-mgr-update-'))
  installDir = path.join(dir, 'dist')
  stateDir = path.join(dir, 'data', 'state')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: '@luckylillia-dev/luckylillia', version: '9.0.0' }))
  writeFileSync(path.join(installDir, 'llbot.js'), '// v9.0.0')
  writeFileSync(path.join(installDir, 'llbot-core.js'), '// v9.0.0')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('managed CoreUpdater orchestration', () => {
  it('resolves installDir even when invoked from dist/chunks', () => {
    const chunks = path.join(installDir, 'chunks')
    mkdirSync(chunks, { recursive: true })
    expect(installDirOf(installDir)).toBe(installDir)
    expect(installDirOf(chunks)).toBe(installDir)
  })

  it('calls beforeReplace after verifying the download and before replacing files, then triggers restart', async () => {
    const order: string[] = []
    const archive = tarGz({
      'package.json': JSON.stringify({ name: '@luckylillia-dev/luckylillia', version: '9.1.0' }),
      'llbot.js': '// v9.1.0',
      'llbot-core.js': '// v9.1.0',
    })
    const restart = vi.fn(() => {
      order.push('restart')
      return true
    })
    const updater = new CoreUpdater({
      installDir,
      current: '9.0.0',
      container: false,
      registry: () => fakeRegistry('9.1.0', archive),
      blocker: async () => undefined,
      beforeReplace: async () => {
        // Original files must still be untouched when stopping instances
        expect(readFileSync(path.join(installDir, 'llbot-core.js'), 'utf8')).toBe('// v9.0.0')
        order.push('beforeReplace')
      },
      restart,
      restartDelay: 10,
    })

    const status = await updater.update('9.1.0')
    expect(status.state).toBe('restarting')
    expect(readFileSync(path.join(installDir, 'llbot-core.js'), 'utf8')).toBe('// v9.1.0')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(order).toEqual(['beforeReplace', 'restart'])
  })

  it('does not call beforeReplace when the staged download fails verification', async () => {
    const beforeReplace = vi.fn(async () => {})
    const brokenArchive = tarGz({
      'package.json': JSON.stringify({ name: '@luckylillia-dev/luckylillia', version: '9.1.0' }),
      // Missing llbot-core.js
      'llbot.js': '// v9.1.0',
    })
    const updater = new CoreUpdater({
      installDir,
      current: '9.0.0',
      container: false,
      registry: () => fakeRegistry('9.1.0', brokenArchive),
      blocker: async () => undefined,
      beforeReplace,
    })

    await expect(updater.update('9.1.0')).rejects.toThrow(/缺少 llbot-core\.js/)
    expect(beforeReplace).not.toHaveBeenCalled()
  })

  it('allows updates in updateBlocker when supervised=true and no external instances run', async () => {
    expect(await updateBlocker(installDir, { supervised: true, ignoreInstances: ['default', 'second'] })).toBeUndefined()
    expect(await updateBlocker(installDir, { supervised: false })).toMatch(/--no-supervisor/)
  })

  it('serves /api/core-update/* centrally through the gateway for both `/` and `/i/<name>/`', async () => {
    const archive = tarGz({
      'package.json': JSON.stringify({ name: '@luckylillia-dev/luckylillia', version: '9.2.0' }),
      'llbot.js': '// v9.2.0',
      'llbot-core.js': '// v9.2.0',
    })
    const updater = new CoreUpdater({
      installDir,
      current: '9.0.0',
      container: false,
      registry: () => fakeRegistry('9.2.0', archive),
      blocker: async () => undefined,
    })
    const auth = new GatewayAuth({ file: path.join(dir, 'webui_token.txt') })
    auth.setToken('pw')
    const gateway = new Gateway({
      auth,
      secret: 's',
      lookup: () => undefined,
      defaultInstance: () => 'default',
      coreUpdate: createCoreUpdateHandler(updater),
    })
    const port = await gateway.listen('127.0.0.1', 0)
    const token = hashPassword('pw')
    try {
      const checked = await fetch(`http://127.0.0.1:${port}/api/core-update/check`, {
        method: 'POST',
        headers: { 'x-webui-token': token },
      })
      expect(checked.status).toBe(200)
      expect(await checked.json()).toMatchObject({
        success: true,
        data: { current: '9.0.0', latest: '9.2.0', available: true },
      })

      // Same status visible under any instance prefix even if that instance is stopped
      const fromInstance = await fetch(`http://127.0.0.1:${port}/i/second/api/core-update/status`, {
        headers: { 'x-webui-token': token },
      })
      expect(fromInstance.status).toBe(200)
      expect(await fromInstance.json()).toMatchObject({
        success: true,
        data: { current: '9.0.0', latest: '9.2.0', available: true },
      })
    } finally {
      await gateway.close()
    }
  })

  it('saves and consumes resume-instances.json once across restarts and reads market registries', () => {
    saveResumeInstances(stateDir, ['default', 'second', '_invalid', 'second'])
    expect(existsSync(path.join(stateDir, 'resume-instances.json'))).toBe(true)
    expect(consumeResumeInstances(stateDir)).toEqual(['default', 'second'])
    expect(consumeResumeInstances(stateDir)).toEqual([])

    const instancesDir = path.join(dir, 'data', 'instances')
    mkdirSync(path.join(instancesDir, 'default'), { recursive: true })
    writeFileSync(
      path.join(instancesDir, 'default', 'plugins.json'),
      JSON.stringify({ entries: [{ id: 'builtin:market', name: 'builtin:market', config: { registry: 'https://registry.npmmirror.com' } }] }),
    )
    expect(managerRegistries(instancesDir, ['default'])).toBeDefined()
  })
})

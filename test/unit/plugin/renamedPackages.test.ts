import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { Context } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import PluginService from '@/plugin/host'

const NEW = '@luckylillia-dev/plugin-aiprovider'
const OLD = '@luckylillia/plugin-aiprovider'
const contexts: Context[] = []
let work: string
let root: string

function writePlugin(directory: string, packageName: string, version = '1.0.1') {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: packageName, version, type: 'module', main: 'index.js', llbot: {},
    peerDependencies: { [packageName === OLD ? '@luckylillia/plugin-sdk' : '@luckylillia-dev/plugin-sdk']: '^1.0.0' },
  }))
  writeFileSync(path.join(directory, 'index.js'), 'export function apply() {}')
}

const oldDir = () => path.join(root, '@luckylillia', 'plugin-aiprovider')
const newDir = () => path.join(root, '@luckylillia-dev', 'plugin-aiprovider')

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TimerService)
  await ctx.plugin(PluginService, { file: path.join(work, 'plugins.json'), roots: [root], instance: 'renamed' })
  return ctx
}

beforeEach(() => {
  mkdirSync('.tmp', { recursive: true })
  work = mkdtempSync(path.resolve('.tmp', 'renamed-packages-'))
  root = path.join(work, 'plugins')
  mkdirSync(root)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  rmSync(work, { recursive: true, force: true })
})

describe('packages renamed to @luckylillia-dev', () => {
  it('runs a package still installed under its old name as the new one', async () => {
    writePlugin(oldDir(), OLD)
    const ctx = await boot()
    expect(ctx.plugins.packageList()).toEqual([expect.objectContaining({ name: NEW, version: '1.0.1' })])
    const [entry] = ctx.plugins.list()
    expect(entry.name).toBe(NEW)
    await ctx.plugins.enable(entry.id)
    expect(ctx.plugins.get(entry.id)).toMatchObject({ state: 'active' })
  })

  it('uses the copy under the new name when both are installed', async () => {
    writePlugin(oldDir(), OLD)
    writePlugin(newDir(), NEW, '1.0.2')
    const ctx = await boot()
    expect(ctx.plugins.packageList()).toEqual([expect.objectContaining({ name: NEW, version: '1.0.2', root: await realpath(newDir()) })])
  })

  it('uninstalls the copy under the old name', async () => {
    writePlugin(oldDir(), OLD)
    const ctx = await boot()
    await ctx.plugins.uninstallPackage(NEW)
    expect(existsSync(oldDir())).toBe(false)
    expect(ctx.plugins.packageList()).toEqual([])
  })

  it('installing the new name takes over from the copy under the old name and removes it', async () => {
    writePlugin(oldDir(), OLD)
    const ctx = await boot()
    const [entry] = ctx.plugins.list()
    await ctx.plugins.enable(entry.id)
    const manifest = { name: NEW, version: '1.0.2', peerDependencies: { '@luckylillia-dev/plugin-sdk': '^1.0.0' }, llbot: {} }
    const outcome = await ctx.plugins.changePackage({ root, name: NEW, kind: 'install', manifest } as never, async () => {
      writePlugin(newDir(), NEW, '1.0.2')
    })
    expect(outcome.instances).toEqual([expect.objectContaining({ status: 'reloaded' })])
    expect(existsSync(oldDir())).toBe(false)
    expect(ctx.plugins.packageList()).toEqual([expect.objectContaining({ name: NEW, version: '1.0.2', root: await realpath(newDir()) })])
    expect(ctx.plugins.get(entry.id)).toMatchObject({ name: NEW, state: 'active' })
  })
})

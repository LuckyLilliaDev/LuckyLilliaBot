import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readPluginPackage, sdkRangeOf } from '@/plugin/host/manifest'
import { currentPackageName, previousPackageName, withCurrentNames } from '@/plugin/host/renamed'
import { sharedSpecifierMap } from '@/plugin/host/resolve-hook'
import { startupPluginNames } from '@/main/startupPlugins'

const root = mkdtempSync(path.join(tmpdir(), 'llbot-renamed-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function pkg(dir: string, manifest: Record<string, unknown>) {
  mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js', llbot: {}, ...manifest }))
  writeFileSync(path.join(root, dir, 'index.js'), 'export const name = "x"; export function apply() {}')
  return path.join(root, dir)
}

describe('packages renamed to @luckylillia-dev', () => {
  it('maps the old names to the new and back, leaving other names', () => {
    expect(currentPackageName('@luckylillia/plugin-onebot11')).toBe('@luckylillia-dev/plugin-onebot11')
    expect(currentPackageName('lucky-lillia-plugin-blipreview')).toBe('@luckylillia-dev/plugin-blipreview')
    expect(currentPackageName('@example/other')).toBe('@example/other')
    expect(previousPackageName('@luckylillia-dev/market')).toBe('@luckylillia/market')
    expect(previousPackageName('@example/other')).toBeUndefined()
  })

  it('reads a package still under its old name as the new one, its old peer and dependency names too', async () => {
    const dir = pkg('@luckylillia/plugin-milky', {
      name: '@luckylillia/plugin-milky', version: '1.0.0',
      peerDependencies: { '@luckylillia/plugin-sdk': '^1.0.0' },
      llbot: { dependencies: { '@luckylillia/plugin-nt-protocol': '^1.0.0', '@example/other': '^2.0.0' } },
    })
    const read = await readPluginPackage(dir)
    expect(read?.name).toBe('@luckylillia-dev/plugin-milky')
    expect(read?.previousName).toBe('@luckylillia/plugin-milky')
    expect(read?.sdkRange).toBe('^1.0.0')
    expect(read?.manifest.dependencies).toEqual({ '@luckylillia-dev/plugin-nt-protocol': '^1.0.0', '@example/other': '^2.0.0' })
  })

  it('reads a package under its new name as it is', async () => {
    const read = await readPluginPackage(pkg('@luckylillia-dev/plugin-milky', {
      name: '@luckylillia-dev/plugin-milky', version: '1.1.0', peerDependencies: { '@luckylillia-dev/plugin-sdk': '^1.1.0' },
    }))
    expect(read?.name).toBe('@luckylillia-dev/plugin-milky')
    expect(read?.previousName).toBeUndefined()
    expect(read?.sdkRange).toBe('^1.1.0')
  })

  it('prefers the new name where a package lists both', () => {
    expect(sdkRangeOf({ '@luckylillia/plugin-sdk': '^1.0.0', '@luckylillia-dev/plugin-sdk': '^2.0.0' })).toBe('^2.0.0')
    expect(withCurrentNames({ '@luckylillia/plugin-webqq': '1', '@luckylillia-dev/plugin-webqq': '2' })).toEqual({ '@luckylillia-dev/plugin-webqq': '2' })
  })

  it('gives plugins importing the old SDK name the host\'s SDK', () => {
    const shared = sharedSpecifierMap()
    expect(shared.get('@luckylillia-dev/plugin-sdk')).toBeTruthy()
    expect(shared.get('@luckylillia/plugin-sdk')).toBe(shared.get('@luckylillia-dev/plugin-sdk'))
  })

  it('takes --plugin with the old names', () => {
    expect(startupPluginNames(['node', 'llbot.js', '--plugin', '@luckylillia/plugin-nt-protocol,lucky-lillia-plugin-ffmpeg'])).toEqual([
      '@luckylillia-dev/plugin-nt-protocol', '@luckylillia-dev/plugin-ffmpeg',
    ])
  })
})

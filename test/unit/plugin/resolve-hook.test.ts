import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isCommonJS, isModulePackage, resolvePluginSpecifier as resolveWith, ResolverState } from '@/plugin/host/resolve-hook'

const state: ResolverState = {
  shared: new Map([['cordis', 'file:///host/node_modules/cordis/lib/index.js']]),
  roots: ['file:///data/plugins/foo/', 'file:///data/plugins/foo-bar/'],
}

const context = (parentURL?: string) => ({ conditions: ['node', 'import'], importAttributes: {}, parentURL })

// Mimics the default resolver for relative and package specifiers
const nextResolve = (specifier: string, ctx?: { parentURL?: string }) => {
  if (specifier.startsWith('.')) return { url: new URL(specifier, ctx?.parentURL).href }
  return { url: `file:///host/node_modules/${specifier}/index.js` }
}

// The packages here are ES modules ("type": "module"), unless a test says otherwise
const esm = () => true
const resolvePluginSpecifier: typeof resolveWith = (state, specifier, ctx, next, moduleType = esm) =>
  resolveWith(state, specifier, ctx, next, moduleType)

describe('resolvePluginSpecifier', () => {
  it('pins shared packages to the host copy from anywhere', () => {
    expect(resolvePluginSpecifier(state, 'cordis', context('file:///data/plugins/foo/index.js?v=3'), nextResolve))
      .toEqual({ url: 'file:///host/node_modules/cordis/lib/index.js', shortCircuit: true })
    expect(resolvePluginSpecifier(state, 'cordis', context('file:///host/src/main.ts'), nextResolve).url)
      .toBe('file:///host/node_modules/cordis/lib/index.js')
  })

  it('copies the reload epoch to modules inside the same package', () => {
    expect(resolvePluginSpecifier(state, './lib/util.js', context('file:///data/plugins/foo/index.js?v=3'), nextResolve).url)
      .toBe('file:///data/plugins/foo/lib/util.js?v=3')
    // Its own node_modules too: the market updates them in place. Vitest loads plugins through its own module
    // runner, which never asks this hook, so market.test.ts cannot see it
    const ownDependency = (specifier: string) => ({ url: `file:///data/plugins/foo/node_modules/${specifier}/index.js` })
    expect(resolvePluginSpecifier(state, 'a', context('file:///data/plugins/foo/index.js?v=3'), ownDependency).url)
      .toBe('file:///data/plugins/foo/node_modules/a/index.js?v=3')
  })

  it('leaves CommonJS files in the package without the epoch, which an ES import of them would break', () => {
    const ownDependency = (specifier: string) => ({ url: `file:///data/plugins/foo/node_modules/${specifier}` })
    const cjs = () => false
    expect(resolvePluginSpecifier(state, 'debug/src/index.js', context('file:///data/plugins/foo/node_modules/z/lib/zip.js?v=3'), ownDependency, cjs).url)
      .toBe('file:///data/plugins/foo/node_modules/debug/src/index.js')
    expect(resolvePluginSpecifier(state, 'a/index.cjs', context('file:///data/plugins/foo/index.js?v=3'), ownDependency).url)
      .toBe('file:///data/plugins/foo/node_modules/a/index.cjs')
    // .mjs is an ES module whatever the package says
    expect(resolvePluginSpecifier(state, 'a/index.mjs', context('file:///data/plugins/foo/index.js?v=3'), ownDependency, cjs).url)
      .toBe('file:///data/plugins/foo/node_modules/a/index.mjs?v=3')
  })

  it('leaves imports outside the package alone', () => {
    expect(resolvePluginSpecifier(state, 'ws', context('file:///data/plugins/foo/index.js?v=3'), nextResolve).url)
      .toBe('file:///host/node_modules/ws/index.js')
    expect(resolvePluginSpecifier(state, '../foo-bar/x.js', context('file:///data/plugins/foo/index.js?v=3'), nextResolve).url)
      .toBe('file:///data/plugins/foo-bar/x.js')
  })

  it('does nothing for modules that were not loaded through a reload epoch', () => {
    expect(resolvePluginSpecifier(state, './a.js', context('file:///data/plugins/foo/index.js'), nextResolve).url)
      .toBe('file:///data/plugins/foo/a.js')
    expect(resolvePluginSpecifier(state, 'ws', context(undefined), nextResolve).url)
      .toBe('file:///host/node_modules/ws/index.js')
  })

  it('matches the longest package root', () => {
    expect(resolvePluginSpecifier(state, './x.js', context('file:///data/plugins/foo-bar/index.js?v=9'), nextResolve).url)
      .toBe('file:///data/plugins/foo-bar/x.js?v=9')
  })
})

describe('isCommonJS', () => {
  it('reads "type" from the nearest package.json, as Node does', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llbot-resolve-'))
    try {
      mkdirSync(path.join(dir, 'esm', 'lib'), { recursive: true })
      mkdirSync(path.join(dir, 'cjs', 'src'), { recursive: true })
      writeFileSync(path.join(dir, 'esm', 'package.json'), JSON.stringify({ name: 'esm', type: 'module' }))
      writeFileSync(path.join(dir, 'cjs', 'package.json'), JSON.stringify({ name: 'cjs' }))
      const url = (...parts: string[]) => pathToFileURL(path.join(dir, ...parts)).href + '?v=2'
      expect(isCommonJS(url('esm', 'lib', 'index.js'), isModulePackage)).toBe(false)
      expect(isCommonJS(url('cjs', 'src', 'index.js'), isModulePackage)).toBe(true)
      expect(isCommonJS(url('esm', 'lib', 'a.cjs'), isModulePackage)).toBe(true)
      expect(isCommonJS(url('cjs', 'src', 'a.mjs'), isModulePackage)).toBe(false)
      // No package.json up to the temp directory's own: CommonJS, Node's default
      writeFileSync(path.join(dir, 'loose.js'), '')
      expect(isCommonJS(url('loose.js'), isModulePackage)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

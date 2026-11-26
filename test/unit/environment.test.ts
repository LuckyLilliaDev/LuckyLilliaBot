import { describe, it, expect, vi } from 'vitest'

// setup.ts 把整个 environment 模块 mock 掉了, 这里要测真实实现
vi.unmock('@/common/utils/environment')

import { getInstanceArg, getPluginDirs, isPluginHmr } from '@/common/utils/environment'

const argv = (...args: string[]) => ['node', 'main.ts', ...args]

describe('getPluginDirs', () => {
  it('collects every occurrence in both forms', () => {
    expect(getPluginDirs(argv('--plugin-dir', 'a', '--plugin-dir=b', '--qq', '1'))).toEqual(['a', 'b'])
  })

  it('ignores a missing value and does not swallow the next flag', () => {
    expect(getPluginDirs(argv('--plugin-dir', '--plugin-hmr'))).toEqual([])
    expect(getPluginDirs(argv('--plugin-dir='))).toEqual([])
    expect(getPluginDirs(argv())).toEqual([])
  })
})

describe('isPluginHmr', () => {
  it('is only on with the flag', () => {
    expect(isPluginHmr(argv('--plugin-hmr'))).toBe(true)
    expect(isPluginHmr(argv('--dev'))).toBe(false)
  })
})

describe('getInstanceArg', () => {
  it('takes --instance in both forms, ahead of LLBOT_INSTANCE', () => {
    expect(getInstanceArg(argv('--instance', 'work'), {})).toBe('work')
    expect(getInstanceArg(argv('--instance=work'), { LLBOT_INSTANCE: 'env' })).toBe('work')
    expect(getInstanceArg(argv(), { LLBOT_INSTANCE: 'env' })).toBe('env')
  })

  it('has nothing without either, and does not swallow the next flag', () => {
    expect(getInstanceArg(argv(), {})).toBeUndefined()
    expect(getInstanceArg(argv('--instance', '--dev'), {})).toBeUndefined()
    expect(getInstanceArg(argv('--instance='), { LLBOT_INSTANCE: '' })).toBeUndefined()
  })
})

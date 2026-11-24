import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, showToastMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  showToastMock: vi.fn(),
}))

vi.mock('@/plugin/internal/service/webui/FE/utils/api', () => ({
  apiFetch: apiFetchMock,
}))

vi.mock('@/plugin/internal/service/webui/FE/components/common', () => ({
  showToast: showToastMock,
}))

import {
  coreUpdateProgressMessage,
  PREFS_STORAGE_KEY,
  readUpdatePrefs,
  shouldShowBanner,
  shouldShowSidebarDot,
  SNOOZE_DURATION,
  useCoreUpdateStore,
  writeUpdatePrefs,
  type CoreUpdateStatus,
} from '@/plugin/internal/service/webui/FE/stores/coreUpdateStore'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    clear: () => { map.clear() },
  }
}

const availableStatus = (latest = '9.1.0'): CoreUpdateStatus => ({
  current: '9.0.0',
  latest,
  available: true,
  state: 'idle',
  checkedAt: Date.now(),
})

describe('core update reminder preferences', () => {
  it('reads and writes preferences cleanly and tolerates malformed storage', () => {
    const storage = memoryStorage()
    expect(readUpdatePrefs(storage)).toEqual({})
    writeUpdatePrefs({ skippedVersion: '9.1.0', snoozedVersion: '9.1.0', snoozeUntil: 12345 }, storage)
    expect(readUpdatePrefs(storage)).toEqual({ skippedVersion: '9.1.0', snoozedVersion: '9.1.0', snoozeUntil: 12345 })

    storage.setItem(PREFS_STORAGE_KEY, '{broken json')
    expect(readUpdatePrefs(storage)).toEqual({})
  })

  it('shows banner and sidebar dot only when an update is available and not skipped', () => {
    const status = availableStatus('9.1.0')
    expect(shouldShowBanner(null, {}, 1000)).toBe(false)
    expect(shouldShowSidebarDot(null, {})).toBe(false)
    expect(shouldShowBanner({ ...status, available: false }, {}, 1000)).toBe(false)
    expect(shouldShowSidebarDot({ ...status, available: false }, {})).toBe(false)

    expect(shouldShowBanner(status, {}, 1000)).toBe(true)
    expect(shouldShowSidebarDot(status, {})).toBe(true)

    // Skipping 9.1.0 hides both until a newer version arrives
    expect(shouldShowBanner(status, { skippedVersion: '9.1.0' }, 1000)).toBe(false)
    expect(shouldShowSidebarDot(status, { skippedVersion: '9.1.0' })).toBe(false)
    expect(shouldShowBanner(availableStatus('9.2.0'), { skippedVersion: '9.1.0' }, 1000)).toBe(true)
    expect(shouldShowSidebarDot(availableStatus('9.2.0'), { skippedVersion: '9.1.0' })).toBe(true)
  })

  it('hides the banner for 24h when snoozed, keeps the sidebar dot, and re-shows on expiry or newer version', () => {
    const now = 1_700_000_000_000
    const status = availableStatus('9.1.0')
    const snoozed = { snoozedVersion: '9.1.0', snoozeUntil: now + SNOOZE_DURATION }

    expect(shouldShowBanner(status, snoozed, now)).toBe(false)
    expect(shouldShowBanner(status, snoozed, now + SNOOZE_DURATION - 1)).toBe(false)
    expect(shouldShowSidebarDot(status, snoozed)).toBe(true)

    // After 24h, the banner comes back
    expect(shouldShowBanner(status, snoozed, now + SNOOZE_DURATION)).toBe(true)

    // A newer release overrides the snooze immediately
    expect(shouldShowBanner(availableStatus('9.2.0'), snoozed, now + 1000)).toBe(true)
  })

  it('produces a persistent progress message only while downloading, installing, or restarting', () => {
    expect(coreUpdateProgressMessage(null, null)).toBeNull()
    expect(coreUpdateProgressMessage(availableStatus('9.1.0'), null)).toBeNull()
    expect(coreUpdateProgressMessage({ ...availableStatus('9.1.0'), state: 'checking' }, null)).toBeNull()

    expect(coreUpdateProgressMessage({ ...availableStatus('9.1.0'), state: 'downloading' }, null)).toBe('正在下载 9.1.0…')
    expect(coreUpdateProgressMessage({ ...availableStatus('9.1.0'), state: 'installing' }, null)).toBe('正在安装 9.1.0…')
    expect(coreUpdateProgressMessage({ ...availableStatus('9.1.0'), state: 'restarting' }, null)).toBe('正在重启到 9.1.0，完成后页面会自动刷新…')
    expect(coreUpdateProgressMessage(availableStatus('9.1.0'), '9.1.0', false)).toBe('正在重启到 9.1.0，完成后页面会自动刷新…')
    expect(coreUpdateProgressMessage(availableStatus('9.1.0'), '9.1.0', true)).toBe('Bot 重启的时间比预期长，可以稍后手动刷新页面')
  })
})

describe('useCoreUpdateStore', () => {
  const storage = memoryStorage()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', storage)
    useCoreUpdateStore.getState().stopRestartPolling()
    useCoreUpdateStore.setState({
      status: null,
      unavailable: '',
      prefs: {},
      now: Date.now(),
      lastSyncedAt: 0,
      target: null,
      waitedTooLong: false,
      bannerError: '',
      releaseNotesVersion: null,
    })
  })

  afterEach(() => {
    useCoreUpdateStore.getState().stopRestartPolling()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('persists skip and 24h snooze choices to browser localStorage', () => {
    const now = 1_700_000_000_000
    useCoreUpdateStore.getState().snoozeVersion('9.1.0', now)
    expect(useCoreUpdateStore.getState().prefs).toEqual({
      snoozedVersion: '9.1.0',
      snoozeUntil: now + SNOOZE_DURATION,
    })
    expect(readUpdatePrefs(storage)).toEqual({
      snoozedVersion: '9.1.0',
      snoozeUntil: now + SNOOZE_DURATION,
    })

    useCoreUpdateStore.getState().skipVersion('9.1.0')
    expect(readUpdatePrefs(storage).skippedVersion).toBe('9.1.0')
  })

  it('tracks release notes dialog open/close state', () => {
    useCoreUpdateStore.getState().openReleaseNotes('9.1.0')
    expect(useCoreUpdateStore.getState().releaseNotesVersion).toBe('9.1.0')
    useCoreUpdateStore.getState().closeReleaseNotes()
    expect(useCoreUpdateStore.getState().releaseNotesVersion).toBeNull()
  })

  it('polls until the new version comes up and reloads the page', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    useCoreUpdateStore.setState({ status: availableStatus('9.1.0') })

    apiFetchMock
      .mockResolvedValueOnce({ success: true, data: { ...availableStatus('9.1.0'), state: 'restarting' } })
      .mockRejectedValueOnce(new Error('restarting'))
      .mockResolvedValueOnce({ success: true, data: { current: '9.1.0', latest: '9.1.0', available: false, state: 'idle' } })

    await useCoreUpdateStore.getState().startUpdate('9.1.0')
    expect(useCoreUpdateStore.getState().target).toBe('9.1.0')

    await vi.advanceTimersByTimeAsync(2000)
    expect(reload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(showToastMock).toHaveBeenCalledWith('已更新到 9.1.0', 'success')
    await vi.advanceTimersByTimeAsync(800)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('surfaces an update failure cleanly in both status and bannerError', async () => {
    useCoreUpdateStore.setState({ status: availableStatus('9.1.0') })
    apiFetchMock.mockRejectedValueOnce(new Error('磁盘空间不足'))

    await useCoreUpdateStore.getState().startUpdate('9.1.0')
    expect(useCoreUpdateStore.getState().target).toBeNull()
    expect(useCoreUpdateStore.getState().status?.state).toBe('idle')
    expect(useCoreUpdateStore.getState().status?.error).toBe('磁盘空间不足')
    expect(useCoreUpdateStore.getState().bannerError).toBe('磁盘空间不足')

    useCoreUpdateStore.getState().clearBannerError()
    expect(useCoreUpdateStore.getState().bannerError).toBe('')
  })
})

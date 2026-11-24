import { useEffect } from 'react'
import { create } from 'zustand'
import { apiFetch } from '../utils/api'
import { showToast } from '../components/common'

/** What /api/core-update/status answers (src/main/coreUpdate.ts) */
export interface CoreUpdateStatus {
  current: string
  latest?: string
  available: boolean
  blocked?: string
  incompatible?: string
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting'
  error?: string
  checkedAt?: number
}

/** What /api/core-update/release-notes answers (src/main/coreUpdate.ts) */
export interface ReleaseNotes {
  version: string
  title: string
  body: string
  url: string
  publishedAt?: string
}

/** Per-browser reminder preferences kept in localStorage */
export interface UpdatePrefs {
  skippedVersion?: string
  snoozedVersion?: string
  snoozeUntil?: number
}

export const PREFS_STORAGE_KEY = 'llbot-core-update-prefs'
export const SNOOZE_DURATION = 24 * 60 * 60 * 1000
export const ABOUT_CHECK_STALE = 10 * 60_000
const STATUS_SYNC_INTERVAL = 10 * 60_000
const FOCUS_SYNC_COOLDOWN = 5 * 60_000
const RESTART_POLL = 2000
/** How long to wait for the new version to answer before asking for a manual reload */
const RESTART_TIMEOUT = 3 * 60_000

export const releasePageUrl = (version: string) => `https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/v${version}`

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function readUpdatePrefs(storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): UpdatePrefs {
  if (!storage) return {}
  try {
    const raw = storage.getItem(PREFS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const prefs: UpdatePrefs = {}
    if (typeof parsed.skippedVersion === 'string' && parsed.skippedVersion) prefs.skippedVersion = parsed.skippedVersion
    if (typeof parsed.snoozedVersion === 'string' && parsed.snoozedVersion) prefs.snoozedVersion = parsed.snoozedVersion
    if (typeof parsed.snoozeUntil === 'number' && Number.isFinite(parsed.snoozeUntil)) prefs.snoozeUntil = parsed.snoozeUntil
    return prefs
  } catch {
    return {}
  }
}

export function writeUpdatePrefs(prefs: UpdatePrefs, storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Private browsing or quota full: keep in memory for this session
  }
}

export function shouldShowSidebarDot(status: CoreUpdateStatus | null, prefs: UpdatePrefs): boolean {
  if (!status?.available || !status.latest) return false
  return prefs.skippedVersion !== status.latest
}

export function shouldShowBanner(status: CoreUpdateStatus | null, prefs: UpdatePrefs, now = Date.now()): boolean {
  if (!shouldShowSidebarDot(status, prefs)) return false
  const latest = status!.latest!
  if (prefs.snoozedVersion === latest && prefs.snoozeUntil !== undefined && now < prefs.snoozeUntil) {
    return false
  }
  return true
}

/**
 * Non-null while a core update is actively downloading, installing, or waiting for the new version to come back.
 * Shown persistently at the top of the WebUI regardless of which page is open or whether instances are stopped.
 */
export function coreUpdateProgressMessage(
  status: CoreUpdateStatus | null,
  target: string | null,
  waitedTooLong = false,
): string | null {
  if (target) {
    return waitedTooLong
      ? 'Bot 重启的时间比预期长，可以稍后手动刷新页面'
      : `正在重启到 ${target}，完成后页面会自动刷新…`
  }
  if (!status) return null
  const version = status.latest
  switch (status.state) {
    case 'downloading':
      return version ? `正在下载 ${version}…` : '正在下载新版本…'
    case 'installing':
      return version ? `正在安装 ${version}…` : '正在安装新版本…'
    case 'restarting':
      return version ? `正在重启到 ${version}，完成后页面会自动刷新…` : '正在重启，完成后页面会自动刷新…'
    default:
      return null
  }
}

let restartTimer: ReturnType<typeof setInterval> | undefined

function clearRestartTimer() {
  if (restartTimer !== undefined) {
    clearInterval(restartTimer)
    restartTimer = undefined
  }
}

interface CoreUpdateStoreState {
  status: CoreUpdateStatus | null
  unavailable: string
  prefs: UpdatePrefs
  /** Updated when syncing or acting, so an expired snooze re-renders without reload */
  now: number
  lastSyncedAt: number
  /** The version being installed, while waiting for the bot to come back with it */
  target: string | null
  waitedTooLong: boolean
  /** Error produced by starting an update from outside the About page */
  bannerError: string
  releaseNotesVersion: string | null

  fetchStatus(): Promise<CoreUpdateStatus | null>
  check(options?: { toastOnError?: boolean }): Promise<CoreUpdateStatus | null>
  startUpdate(version: string): Promise<void>
  skipVersion(version: string): void
  snoozeVersion(version: string, now?: number): void
  clearBannerError(): void
  openReleaseNotes(version: string): void
  closeReleaseNotes(): void
  stopRestartPolling(): void
}

export const useCoreUpdateStore = create<CoreUpdateStoreState>((set, get) => ({
  status: null,
  unavailable: '',
  prefs: readUpdatePrefs(),
  now: Date.now(),
  lastSyncedAt: 0,
  target: null,
  waitedTooLong: false,
  bannerError: '',
  releaseNotesVersion: null,

  async fetchStatus() {
    try {
      const response = await apiFetch<CoreUpdateStatus>('/api/core-update/status')
      const now = Date.now()
      set({ status: response.data, unavailable: '', lastSyncedAt: now, now })
      return response.data
    } catch (error) {
      set({ unavailable: errorText(error), now: Date.now() })
      return null
    }
  },

  async check({ toastOnError = true } = {}) {
    const current = get().status
    if (current && current.state !== 'idle') return current
    if (current) set({ status: { ...current, state: 'checking' } })
    try {
      const response = await apiFetch<CoreUpdateStatus>('/api/core-update/check', { method: 'POST' })
      const now = Date.now()
      set({ status: response.data, unavailable: '', lastSyncedAt: now, now })
      return response.data
    } catch (error) {
      const message = errorText(error)
      set(state => ({
        status: state.status?.state === 'checking' ? { ...state.status, state: 'idle' } : state.status,
        now: Date.now(),
      }))
      if (toastOnError) showToast(`检查更新失败：${message}`, 'error')
      return null
    }
  },

  async startUpdate(version: string) {
    const current = get().status
    set({
      status: current
        ? { ...current, latest: version, state: 'downloading', error: undefined }
        : { current: '', latest: version, available: true, state: 'downloading' },
      waitedTooLong: false,
      bannerError: '',
    })
    let progressTimer: ReturnType<typeof setInterval> | undefined
    progressTimer = setInterval(async () => {
      try {
        const poll = await apiFetch<CoreUpdateStatus>('/api/core-update/status')
        if (poll.data.state !== 'idle') {
          set({ status: { ...poll.data, latest: poll.data.latest ?? version } })
        }
      } catch {
        // Ignore transient errors while update is running
      }
    }, 1500)
    try {
      const response = await apiFetch<CoreUpdateStatus>('/api/core-update/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      })
      clearInterval(progressTimer)
      progressTimer = undefined
      set({ status: response.data, target: version, waitedTooLong: false, bannerError: '' })
      clearRestartTimer()
      const started = Date.now()
      restartTimer = setInterval(async () => {
        if (Date.now() - started > RESTART_TIMEOUT) set({ waitedTooLong: true })
        try {
          const poll = await apiFetch<CoreUpdateStatus>('/api/core-update/status')
          if (poll.data.current === version) {
            clearRestartTimer()
            showToast(`已更新到 ${version}`, 'success')
            // The page itself is the old version's: load the new one
            setTimeout(() => window.location.reload(), 800)
          } else if (poll.data.state === 'idle' && poll.data.error) {
            // Back on the old version: the update did not go through
            clearRestartTimer()
            set({ target: null, status: poll.data, bannerError: poll.data.error, waitedTooLong: false })
          }
        } catch {
          // Down while it restarts
        }
      }, RESTART_POLL)
    } catch (error) {
      if (progressTimer !== undefined) clearInterval(progressTimer)
      const message = errorText(error)
      set(state => ({
        status: state.status ? { ...state.status, state: 'idle', error: message } : state.status,
        bannerError: message,
      }))
    }
  },

  skipVersion(version: string) {
    const prefs: UpdatePrefs = { ...get().prefs, skippedVersion: version }
    writeUpdatePrefs(prefs)
    set({ prefs, now: Date.now(), bannerError: '' })
  },

  snoozeVersion(version: string, now = Date.now()) {
    const prefs: UpdatePrefs = {
      ...get().prefs,
      snoozedVersion: version,
      snoozeUntil: now + SNOOZE_DURATION,
    }
    writeUpdatePrefs(prefs)
    set({ prefs, now, bannerError: '' })
  },

  clearBannerError() {
    set({ bannerError: '' })
  },

  openReleaseNotes(version: string) {
    set({ releaseNotesVersion: version })
  },

  closeReleaseNotes() {
    set({ releaseNotesVersion: null })
  },

  stopRestartPolling() {
    clearRestartTimer()
  },
}))

/** Syncs backend auto-check status after WebUI login and periodically while the tab stays open. */
export function useCoreUpdatePolling(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let followUp: ReturnType<typeof setTimeout> | undefined

    const scheduleFollowUpIfBusy = (status: CoreUpdateStatus | null) => {
      if (stopped || !status || status.state === 'idle' || useCoreUpdateStore.getState().target) return
      clearTimeout(followUp)
      followUp = setTimeout(() => { void syncStatus() }, RESTART_POLL)
    }

    const syncStatus = async () => {
      const status = await useCoreUpdateStore.getState().fetchStatus()
      scheduleFollowUpIfBusy(status)
      return status
    }

    const initial = async () => {
      const status = await syncStatus()
      if (stopped || !status) return
      // Backend checks shortly after startup; if this login beat that timer, check right away
      if (!status.checkedAt && status.state === 'idle') {
        await useCoreUpdateStore.getState().check({ toastOnError: false })
      }
    }
    void initial()

    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const syncIfDue = () => {
      if (stopped || !visible()) return
      const { lastSyncedAt, target } = useCoreUpdateStore.getState()
      if (target) return
      const now = Date.now()
      useCoreUpdateStore.setState({ now })
      if (now - lastSyncedAt >= FOCUS_SYNC_COOLDOWN) {
        void syncStatus()
      }
    }

    const timer = setInterval(() => {
      if (stopped || !visible() || useCoreUpdateStore.getState().target) return
      void syncStatus()
    }, STATUS_SYNC_INTERVAL)

    window.addEventListener('focus', syncIfDue)
    document.addEventListener('visibilitychange', syncIfDue)

    return () => {
      stopped = true
      clearTimeout(followUp)
      clearInterval(timer)
      window.removeEventListener('focus', syncIfDue)
      document.removeEventListener('visibilitychange', syncIfDue)
    }
  }, [enabled])
}

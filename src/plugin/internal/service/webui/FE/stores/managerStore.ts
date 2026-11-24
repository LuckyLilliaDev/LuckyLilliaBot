import { useEffect } from 'react'
import { create } from 'zustand'
import { listManagedInstances, type ManagedInstance, probeManagerInstances } from '../utils/managerApi'

export type ManagerStatus = 'unknown' | 'managed' | 'standalone'

interface ManagerState {
  status: ManagerStatus
  instances: ManagedInstance[]
  selected: string
  loading: boolean
  error: string
  probe(): Promise<boolean>
  refresh(): Promise<void>
}

export const useManagerStore = create<ManagerState>((set, get) => ({
  status: 'unknown',
  instances: [],
  selected: 'default',
  loading: false,
  error: '',

  async probe() {
    set({ loading: true, error: '' })
    try {
      const data = await probeManagerInstances()
      if (!data) {
        set({ status: 'standalone', instances: [], loading: false })
        return false
      }
      set({
        status: 'managed',
        instances: data.instances,
        selected: data.selected,
        loading: false,
      })
      return true
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  },

  async refresh() {
    if (get().status !== 'managed') return
    try {
      const data = await listManagedInstances()
      set({ instances: data.instances, selected: data.selected, error: '' })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },
}))

const LAST_INSTANCE_KEY = 'llbot:lastInstance'

export function rememberLastInstance(name: string): void {
  try {
    localStorage.setItem(LAST_INSTANCE_KEY, name)
  } catch {
    // Restricted storage environment
  }
}

export function readLastInstance(): string | undefined {
  try {
    return localStorage.getItem(LAST_INSTANCE_KEY) || undefined
  } catch {
    return undefined
  }
}

export function clearLastInstance(): void {
  try {
    localStorage.removeItem(LAST_INSTANCE_KEY)
  } catch {
    // Restricted storage environment
  }
}

/** Polls the manager's instance list while the page is visible. Polls faster during state transitions. */
export function useManagerPolling(enabled: boolean, fast = false) {
  const status = useManagerStore(state => state.status)
  const transitioning = useManagerStore(state =>
    state.instances.some(inst => inst.phase === 'starting' || inst.phase === 'stopping'),
  )

  useEffect(() => {
    if (!enabled || status !== 'managed') return
    let stopped = false
    const interval = transitioning ? 1000 : fast ? 2500 : 10_000
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

    const tick = () => {
      if (stopped || !visible()) return
      void useManagerStore.getState().refresh()
    }

    const timer = setInterval(tick, interval)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)

    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, status, fast, transitioning])
}

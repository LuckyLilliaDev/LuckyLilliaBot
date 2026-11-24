import React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { coreUpdateProgressMessage, useCoreUpdateStore } from '../../stores/coreUpdateStore'

/**
 * Sticky top bar shown across every page (including About, offline shell, and fullscreen views)
 * whenever a core update is downloading, installing, or restarting.
 */
const CoreUpdateBar: React.FC = () => {
  const status = useCoreUpdateStore(state => state.status)
  const target = useCoreUpdateStore(state => state.target)
  const waitedTooLong = useCoreUpdateStore(state => state.waitedTooLong)

  const message = coreUpdateProgressMessage(status, target, waitedTooLong)
  if (!message) return null

  return (
    <div role="status" aria-live="polite" className="px-4 md:px-8 pt-3 max-w-6xl mx-auto">
      <div className="glass glass-dense rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-theme shadow-md border border-pink-500/25">
        <div className="flex items-center gap-2.5 min-w-0">
          <Loader2 size={16} className="animate-spin text-pink-500 shrink-0" />
          <span className="font-medium">{message}</span>
        </div>
        {waitedTooLong && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-glass px-3 py-1 text-xs inline-flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw size={12} />
            手动刷新
          </button>
        )}
      </div>
    </div>
  )
}

export default CoreUpdateBar

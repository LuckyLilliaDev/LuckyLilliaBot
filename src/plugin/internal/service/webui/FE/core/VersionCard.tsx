import React, { useEffect, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, FileText, Info, Loader2, RefreshCw } from 'lucide-react'
import { version as builtVersion } from '../../../../../../version'
import { ABOUT_CHECK_STALE, useCoreUpdateStore, type CoreUpdateStatus } from '../stores/coreUpdateStore'

const STATE_TEXT: Record<CoreUpdateStatus['state'], string> = {
  idle: '', checking: '正在检查…', downloading: '正在下载新版本…', installing: '正在安装新版本…', restarting: '正在重启…',
}

const VersionCard: React.FC = () => {
  const status = useCoreUpdateStore(state => state.status)
  const unavailable = useCoreUpdateStore(state => state.unavailable)
  const target = useCoreUpdateStore(state => state.target)
  const waitedTooLong = useCoreUpdateStore(state => state.waitedTooLong)
  const fetchStatus = useCoreUpdateStore(state => state.fetchStatus)
  const check = useCoreUpdateStore(state => state.check)
  const startUpdate = useCoreUpdateStore(state => state.startUpdate)
  const openReleaseNotes = useCoreUpdateStore(state => state.openReleaseNotes)

  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const latestStatus = await fetchStatus()
      if (!alive || !latestStatus) return
      if (latestStatus.state === 'idle' && (!latestStatus.checkedAt || Date.now() - latestStatus.checkedAt > ABOUT_CHECK_STALE)) {
        void check({ toastOnError: true })
      }
    })()
    return () => { alive = false }
  }, [fetchStatus, check])

  const update = async () => {
    if (!status?.latest) return
    setConfirming(false)
    await startUpdate(status.latest)
  }

  const current = status?.current ?? builtVersion
  const busy = !!status && status.state !== 'idle'
  const upToDate = !!status?.latest && !status.available && !status.incompatible && !status.error && current === status.latest
  const hasNewer = !!status?.latest && status.latest !== current

  return (
    <div className="card p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 shrink-0 rounded-xl gradient-primary-br flex items-center justify-center">
            <Info size={20} className="text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-theme">版本信息</div>
            <div className="text-xs text-theme-muted">
              Lucky Lillia Bot {current}
              {hasNewer && <span>，最新版本 {status.latest}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status && !target && status.available && !busy && (confirming ? (
            <>
              <span className="text-xs text-theme-secondary">更新后 Bot 会自动重启，期间消息收发会中断一会儿</span>
              <button type="button" onClick={() => void update()} className="btn-primary text-sm">确认更新</button>
              <button type="button" onClick={() => setConfirming(false)} className="btn-glass text-sm">取消</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="btn-primary text-sm flex items-center gap-1.5">
              <ArrowUpCircle size={16} />更新到 {status.latest}
            </button>
          ))}
          {status && !target && !busy && !confirming && hasNewer && status.latest && (
            <button type="button" onClick={() => openReleaseNotes(status.latest!)} className="btn-glass text-sm flex items-center gap-1.5">
              <FileText size={16} />查看更新日志
            </button>
          )}
          {status && !target && !busy && !confirming && (
            <button type="button" onClick={() => void check({ toastOnError: true })} className="btn-glass text-sm flex items-center gap-1.5">
              <RefreshCw size={16} />检查更新
            </button>
          )}
        </div>
      </div>

      {(busy || target) && (
        <div className="flex items-center gap-2 text-sm text-theme-secondary">
          <Loader2 size={16} className="animate-spin" />
          {target ? (waitedTooLong ? 'Bot 重启的时间比预期长，可以稍后手动刷新页面' : `正在重启到 ${target}，完成后页面会自动刷新…`) : STATE_TEXT[status!.state]}
        </div>
      )}
      {!busy && !target && upToDate && (
        <div className="flex items-center gap-2 text-sm text-theme-secondary"><CheckCircle2 size={16} className="text-green-500" />已是最新版本</div>
      )}
      {!busy && !target && status?.blocked && hasNewer && (
        <p className="text-sm text-theme-secondary">{status.blocked}</p>
      )}
      {!busy && !target && status?.incompatible && <p className="text-sm text-amber-600 dark:text-amber-400">{status.incompatible}</p>}
      {!busy && !target && status?.error && <p className="text-sm text-red-500 break-words">{status.error}</p>}
      {unavailable && <p className="text-sm text-theme-muted">无法读取更新信息：{unavailable}</p>}

      <div className="text-xs text-theme-muted">
        WebUI Powered by <span className="font-semibold text-pink-500">React + Tailwind</span>
      </div>
    </div>
  )
}

export default VersionCard

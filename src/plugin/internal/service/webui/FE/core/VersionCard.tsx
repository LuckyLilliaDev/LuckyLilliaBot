import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, Info, Loader2, RefreshCw } from 'lucide-react'
import { version as builtVersion } from '../../../../../../version'
import { apiFetch } from '../utils/api'
import { showToast } from '../components/common'

/** What /api/core-update/status answers (src/main/coreUpdate.ts) */
interface UpdateStatus {
  current: string
  latest?: string
  available: boolean
  blocked?: string
  incompatible?: string
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting'
  error?: string
  checkedAt?: number
}

/** A check older than this is repeated when the page opens */
const STALE = 10 * 60_000
const POLL = 2000
/** How long to wait for the new version to answer before asking for a manual reload */
const RESTART_TIMEOUT = 3 * 60_000

const STATE_TEXT: Record<UpdateStatus['state'], string> = {
  idle: '', checking: '正在检查…', downloading: '正在下载新版本…', installing: '正在安装新版本…', restarting: '正在重启…',
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

const VersionCard: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [confirming, setConfirming] = useState(false)
  /** The version being installed, while waiting for the bot to come back with it */
  const [target, setTarget] = useState<string | null>(null)
  const [waitedTooLong, setWaitedTooLong] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const check = useCallback(async () => {
    try {
      const response = await apiFetch<UpdateStatus>('/api/core-update/check', { method: 'POST' })
      if (mounted.current) setStatus(response.data)
    } catch (error) {
      if (mounted.current) showToast(`检查更新失败：${errorText(error)}`, 'error')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch<UpdateStatus>('/api/core-update/status')
        if (!mounted.current) return
        setStatus(response.data)
        if (!response.data.checkedAt || Date.now() - response.data.checkedAt > STALE) void check()
      } catch (error) {
        if (mounted.current) setUnavailable(errorText(error))
      }
    })()
  }, [check])

  // While restarting: the bot goes away, then answers again, with the new version once it is up
  useEffect(() => {
    if (!target) return
    const started = Date.now()
    const timer = setInterval(async () => {
      if (Date.now() - started > RESTART_TIMEOUT) setWaitedTooLong(true)
      try {
        const response = await apiFetch<UpdateStatus>('/api/core-update/status')
        if (!mounted.current) return
        if (response.data.current === target) {
          clearInterval(timer)
          showToast(`已更新到 ${target}`, 'success')
          // The page itself is the old version's: load the new one
          setTimeout(() => window.location.reload(), 800)
        } else if (response.data.state === 'idle' && response.data.error) {
          // Back on the old version: the update did not go through
          clearInterval(timer)
          setTarget(null)
          setStatus(response.data)
        }
      } catch {
        // Down while it restarts
      }
    }, POLL)
    return () => clearInterval(timer)
  }, [target])

  const update = async () => {
    if (!status?.latest) return
    setConfirming(false)
    const version = status.latest
    setStatus({ ...status, state: 'downloading', error: undefined })
    try {
      const response = await apiFetch<UpdateStatus>('/api/core-update/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      })
      setStatus(response.data)
      setTarget(version)
    } catch (error) {
      setStatus(previous => previous && { ...previous, state: 'idle', error: errorText(error) })
    }
  }

  const current = status?.current ?? builtVersion
  const busy = !!status && status.state !== 'idle'
  const upToDate = !!status?.latest && !status.available && !status.incompatible && !status.error && current === status.latest

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
              {status?.latest && status.latest !== current && <span>，最新版本 {status.latest}</span>}
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
          {status && !target && !busy && !confirming && (
            <button type="button" onClick={() => void check()} className="btn-glass text-sm flex items-center gap-1.5">
              <RefreshCw size={16} />检查更新
            </button>
          )}
        </div>
      </div>

      {(busy || target) && (
        <div className="flex items-center gap-2 text-sm text-theme-secondary">
          <Loader2 size={16} className="animate-spin" />
          {target ? (waitedTooLong ? `Bot 重启的时间比预期长，可以稍后手动刷新页面` : `正在重启到 ${target}，完成后页面会自动刷新…`) : STATE_TEXT[status!.state]}
        </div>
      )}
      {!busy && !target && upToDate && (
        <div className="flex items-center gap-2 text-sm text-theme-secondary"><CheckCircle2 size={16} className="text-green-500" />已是最新版本</div>
      )}
      {!busy && !target && status?.blocked && status.latest !== current && (
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

import React, { useEffect, useState } from 'react'
import { ArrowUpCircle, FileText, Loader2, X } from 'lucide-react'
import { usePluginList } from '../../plugin-host/pluginList'
import { useBots } from '../../stores/botsStore'
import { shouldShowBanner, useCoreUpdateStore, type CoreUpdateStatus } from '../../stores/coreUpdateStore'
import { pluginCategory } from '../plugins/listing'

// Status of @satorijs/protocol
const ONLINE = 1

const STATE_TEXT: Record<CoreUpdateStatus['state'], string> = {
  idle: '',
  checking: '正在检查…',
  downloading: '正在下载新版本…',
  installing: '正在安装新版本…',
  restarting: '正在重启…',
}

interface StatusNoticesProps {
  activeTab: string
  onOpen: (tab: string) => void
}

/**
 * What concerns the bot as a whole, above every page: no protocol plugin enabled and no bot online,
 * or a newer core release ready to install.
 */
const StatusNotices: React.FC<StatusNoticesProps> = ({ activeTab, onOpen }) => {
  const bots = useBots(state => state.bots)
  const plugins = usePluginList(state => state.plugins)
  const status = useCoreUpdateStore(state => state.status)
  const prefs = useCoreUpdateStore(state => state.prefs)
  const now = useCoreUpdateStore(state => state.now)
  const target = useCoreUpdateStore(state => state.target)
  const waitedTooLong = useCoreUpdateStore(state => state.waitedTooLong)
  const bannerError = useCoreUpdateStore(state => state.bannerError)
  const startUpdate = useCoreUpdateStore(state => state.startUpdate)
  const skipVersion = useCoreUpdateStore(state => state.skipVersion)
  const snoozeVersion = useCoreUpdateStore(state => state.snoozeVersion)
  const clearBannerError = useCoreUpdateStore(state => state.clearBannerError)
  const openReleaseNotes = useCoreUpdateStore(state => state.openReleaseNotes)

  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setConfirming(false) }, [status?.latest, activeTab])

  // Nothing known for sure before both have answered; the plugin page is where it is seen to
  const showNoProtocol = !!bots && !!plugins && activeTab !== 'plugins'
    && !bots.some(bot => bot.status === ONLINE)
    && !plugins.some(plugin => !plugin.disabled && pluginCategory(plugin) === 'protocol')

  const updating = !!target || (!!status && (status.state === 'downloading' || status.state === 'installing' || status.state === 'restarting'))
  // The About page already shows VersionCard with its own update controls and progress
  const showUpdateProgress = activeTab !== 'about' && updating
  const showUpdatePrompt = activeTab !== 'about' && !updating && shouldShowBanner(status, prefs, now)
  const showStandaloneError = activeTab !== 'about' && !updating && !showUpdatePrompt && !!bannerError

  if (!showNoProtocol && !showUpdateProgress && !showUpdatePrompt && !showStandaloneError) return null

  const latest = status?.latest

  return (
    <div className="space-y-3 mb-6">
      {showUpdateProgress && (
        <div className="card px-5 py-3 flex items-center gap-3 text-sm text-theme-secondary">
          <Loader2 size={16} className="animate-spin text-pink-500 shrink-0" />
          <span>
            {target
              ? (waitedTooLong ? 'Bot 重启的时间比预期长，可以稍后手动刷新页面' : `正在重启到 ${target}，完成后页面会自动刷新…`)
              : STATE_TEXT[status!.state]}
          </span>
        </div>
      )}

      {showUpdatePrompt && latest && status && (
        <div className="card px-5 py-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2.5 flex-1 min-w-[200px]">
              <ArrowUpCircle size={18} className="text-pink-500 shrink-0" />
              <span className="text-theme">
                发现新版本 <span className="font-semibold">v{latest}</span>
                <span className="text-theme-muted ml-1.5">（当前 v{status.current}）</span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {confirming ? (
                <>
                  <span className="text-xs text-theme-secondary">更新后 Bot 会自动重启，期间消息收发会中断一会儿</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false)
                      void startUpdate(latest)
                    }}
                    className="btn-primary px-3.5 py-1.5 text-sm"
                  >
                    确认更新
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="btn-glass px-3.5 py-1.5 text-sm"
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="btn-primary px-3.5 py-1.5 text-sm"
                  >
                    立即更新
                  </button>
                  <button
                    type="button"
                    onClick={() => openReleaseNotes(latest)}
                    className="btn-glass px-3.5 py-1.5 text-sm inline-flex items-center gap-1.5"
                  >
                    <FileText size={14} />查看更新日志
                  </button>
                  <button
                    type="button"
                    title="24 小时内不再提醒"
                    onClick={() => snoozeVersion(latest)}
                    className="btn-glass px-3.5 py-1.5 text-sm"
                  >
                    稍后提醒
                  </button>
                  <button
                    type="button"
                    onClick={() => skipVersion(latest)}
                    className="px-2.5 py-1.5 text-sm text-theme-muted hover:text-theme transition-colors"
                  >
                    跳过此版本
                  </button>
                </>
              )}
            </div>
          </div>
          {bannerError && (
            <p className="text-xs text-red-500 break-words">更新失败：{bannerError}</p>
          )}
        </div>
      )}

      {showStandaloneError && (
        <div className="card px-5 py-3 flex items-center gap-3 text-sm">
          <span className="text-red-500 flex-1 break-words">更新失败：{bannerError}</span>
          <button
            type="button"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={clearBannerError}
            className="p-1 text-theme-muted hover:text-theme transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {showNoProtocol && (
        <div className="card px-5 py-3 flex items-center gap-3 text-sm">
          <span className="text-theme-secondary flex-1">没有启用任何协议端，机器人还收发不了消息</span>
          <button onClick={() => onOpen('plugins')} className="btn-glass px-4 py-1.5 text-sm flex-shrink-0">前往插件页</button>
        </div>
      )}
    </div>
  )
}

export default StatusNotices

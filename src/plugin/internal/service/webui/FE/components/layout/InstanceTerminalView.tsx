import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, Loader2, RefreshCw, Terminal } from 'lucide-react'
import { showToast } from '../common/Toast'
import { getInstanceLogs, type InstancePhase } from '../../utils/managerApi'

const PHASE_LABEL: Record<InstancePhase, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  failed: '启动失败',
  stopped: '已停止',
}

export interface InstanceTerminalViewProps {
  instanceName: string
  phase?: InstancePhase
  onBack: () => void
}

/** Inline terminal output viewer toggled from the instance toolbar (replaces the page area while active). */
const InstanceTerminalView: React.FC<InstanceTerminalViewProps> = ({ instanceName, phase, onBack }) => {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const data = await getInstanceLogs(instanceName)
      setLines(data.lines)
    } catch (error) {
      if (!quiet) showToast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [instanceName])

  useEffect(() => {
    stickBottomRef.current = true
    void load(false)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true)
    }, 2000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      showToast('已复制到剪贴板', 'success')
    } catch {
      showToast('复制失败', 'error')
    }
  }

  return (
    <div className="card overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 5rem)', minHeight: '360px' }}>
      <div className="flex items-center gap-3 px-4 py-3 hairline-b flex-shrink-0">
        <Terminal size={18} className="text-pink-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-theme truncate">终端日志 · {instanceName}</h2>
            {phase && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-theme-item text-theme-muted flex-shrink-0">
                {PHASE_LABEL[phase]}
              </span>
            )}
          </div>
          <p className="text-xs text-theme-muted">保留最近 {lines.length} 行标准输出，自动刷新</p>
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={loading}
          className="btn-glass text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span className="hidden sm:inline">刷新</span>
        </button>
        <button
          type="button"
          onClick={() => void copyLogs()}
          disabled={lines.length === 0}
          className="btn-glass text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <Copy size={14} />
          <span className="hidden sm:inline">复制</span>
        </button>
        <button
          type="button"
          onClick={onBack}
          className="btn-glass text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
        >
          <ArrowLeft size={14} />
          <span>返回页面</span>
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-4 bg-slate-950/95 text-slate-100 font-mono text-xs leading-relaxed"
      >
        {loading && lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400 gap-2">
            <Loader2 size={18} className="animate-spin" />正在加载…
          </div>
        ) : lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-400">
            暂无输出（该实例尚未在本次运行中启动）
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-all m-0">{lines.join('\n')}</pre>
        )}
      </div>
    </div>
  )
}

export default InstanceTerminalView

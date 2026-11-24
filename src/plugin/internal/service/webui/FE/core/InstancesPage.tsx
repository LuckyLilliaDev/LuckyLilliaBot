import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import Portal from '../components/common/Portal'
import { showToast } from '../components/common/Toast'
import InstanceTerminalView from '../components/layout/InstanceTerminalView'
import { clearLastInstance, rememberLastInstance, useManagerStore } from '../stores/managerStore'
import { instanceHref, pageInstance } from '../utils/base'
import {
  createInstance,
  deleteInstance,
  type InstancePhase,
  type ManagedInstance,
  patchInstance,
  restartInstance,
  startInstance,
  stopInstance,
} from '../utils/managerApi'

const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const PHASE_STYLE: Record<InstancePhase, { label: string; dot: string; badge: string; spin?: boolean }> = {
  running: {
    label: '运行中',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
  starting: {
    label: '启动中',
    dot: 'bg-amber-400',
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    spin: true,
  },
  stopping: {
    label: '停止中',
    dot: 'bg-amber-400',
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    spin: true,
  },
  failed: {
    label: '启动失败',
    dot: 'bg-red-500',
    badge: 'bg-red-500/15 text-red-700 dark:text-red-300',
  },
  stopped: {
    label: '已停止',
    dot: 'bg-slate-400 dark:bg-slate-500',
    badge: 'bg-theme-item text-theme-muted',
  },
}

const isActive = (phase: InstancePhase) => phase === 'running' || phase === 'starting' || phase === 'stopping'

function formatUptime(startedAt?: number): string | undefined {
  if (!startedAt) return undefined
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

/** Built-in WebUI page for creating, switching, starting/stopping, renaming, deleting, and inspecting LLBot instances. */
const InstancesPage: React.FC = () => {
  const instances = useManagerStore(state => state.instances)
  const refresh = useManagerStore(state => state.refresh)
  const current = pageInstance()

  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [terminalTarget, setTerminalTarget] = useState<string | null>(null)

  // Create dialog
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createAutostart, setCreateAutostart] = useState(false)
  const [createStartNow, setCreateStartNow] = useState(true)
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  // Rename dialog
  const [renamingTarget, setRenamingTarget] = useState<ManagedInstance | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renaming, setRenaming] = useState(false)

  // Delete confirmation dialog
  const [deletingTarget, setDeletingTarget] = useState<ManagedInstance | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!showCreate && !renamingTarget && !deletingTarget) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (showCreate && !creating) setShowCreate(false)
      if (renamingTarget && !renaming) setRenamingTarget(null)
      if (deletingTarget && !deleting) setDeletingTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showCreate, creating, renamingTarget, renaming, deletingTarget, deleting])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  const runAction = async (name: string, label: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(prev => ({ ...prev, [name]: label }))
    try {
      await fn()
      await refresh()
      if (okText) showToast(okText, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
      await refresh()
    } finally {
      setBusy(prev => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const switchTo = (name: string) => {
    rememberLastInstance(name)
    window.location.assign(instanceHref(name))
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = createName.trim()
    if (!INSTANCE_NAME_RE.test(trimmed)) {
      setCreateError('名称需以字母或数字开头，仅含字母、数字、- 和 _，最长 64 字符')
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      await createInstance({ name: trimmed, autostart: createAutostart, start: createStartNow })
      setShowCreate(false)
      setCreateName('')
      setCreateAutostart(false)
      setCreateStartNow(true)
      if (!current) {
        rememberLastInstance(trimmed)
        window.location.assign(`${instanceHref(trimmed)}#instances`)
        return
      }
      await refresh()
      showToast(createStartNow ? `已创建并启动实例 ${trimmed}` : `已创建实例 ${trimmed}`, 'success')
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!renamingTarget) return
    const trimmed = renameValue.trim()
    if (!INSTANCE_NAME_RE.test(trimmed)) {
      setRenameError('名称需以字母或数字开头，仅含字母、数字、- 和 _，最长 64 字符')
      return
    }
    if (trimmed === renamingTarget.name) {
      setRenamingTarget(null)
      return
    }
    setRenaming(true)
    setRenameError('')
    try {
      const oldName = renamingTarget.name
      const wasActive = isActive((instances.find(item => item.name === oldName) ?? renamingTarget).phase)
      await patchInstance(oldName, { renameTo: trimmed })
      setRenamingTarget(null)
      if (current === oldName) {
        rememberLastInstance(trimmed)
        window.location.assign(`${instanceHref(trimmed)}#instances`)
        return
      }
      await refresh()
      showToast(wasActive ? `已重命名为 ${trimmed}，正在重新启动` : `已重命名为 ${trimmed}`, 'success')
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenaming(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingTarget) return
    const targetName = deletingTarget.name
    setDeleting(true)
    try {
      await deleteInstance(targetName)
      setDeletingTarget(null)
      if (current === targetName) {
        const remaining = instances.filter(item => item.name !== targetName)
        const fallback = remaining.find(item => item.isDefault) ?? remaining[0]
        if (fallback) {
          rememberLastInstance(fallback.name)
          window.location.assign(`${instanceHref(fallback.name)}#instances`)
        } else {
          clearLastInstance()
          window.location.assign('/#instances')
        }
        return
      }
      await refresh()
      showToast(`已删除实例 ${targetName}`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error')
      await refresh()
    } finally {
      setDeleting(false)
    }
  }

  if (terminalTarget) {
    const inst = instances.find(item => item.name === terminalTarget)
    return (
      <InstanceTerminalView
        instanceName={terminalTarget}
        phase={inst?.phase}
        onBack={() => setTerminalTarget(null)}
      />
    )
  }

  const runningCount = instances.filter(item => item.phase === 'running').length
  const missingCurrent = Boolean(current && instances.length > 0 && !instances.some(item => item.name === current))

  return (
    <div className="space-y-6">
      {missingCurrent && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-amber-50 dark:bg-amber-900/25 border border-amber-200 dark:border-amber-800/60 text-sm text-amber-700 dark:text-amber-300">
          <AlertCircle size={16} className="flex-shrink-0" />
          <span>当前地址对应的实例「{current}」不存在，可在下方切换其他实例或新建实例。</span>
        </div>
      )}
      <div className="card p-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-[220px]">
          <div className="w-12 h-12 rounded-xl gradient-primary-br flex items-center justify-center flex-shrink-0">
            <Server size={24} className="text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-theme">实例管理</h2>
            <p className="text-sm text-theme-secondary">
              共 {instances.length} 个实例，{runningCount} 个运行中
              {current ? ` · 当前实例：${current}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn-glass text-sm px-3.5 py-2 flex items-center gap-1.5"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />刷新
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateName('')
              setCreateAutostart(false)
              setCreateStartNow(true)
              setCreateError('')
              setShowCreate(true)
            }}
            className="btn-primary text-sm px-4 py-2 flex items-center gap-1.5"
          >
            <Plus size={16} />新建实例
          </button>
        </div>
      </div>

      {instances.length === 0 ? (
        <div className="card p-10 text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-theme-item text-theme-muted flex items-center justify-center">
            <Server size={24} />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-theme">还没有任何实例</h3>
            <p className="text-sm text-theme-secondary">创建一个实例即可启动 Bot，所有实例共用当前网关端口与登录密码。</p>
          </div>
          <div>
            <button
              type="button"
              onClick={() => {
                setCreateName('')
                setCreateAutostart(true)
                setCreateStartNow(true)
                setCreateError('')
                setShowCreate(true)
              }}
              className="btn-primary text-sm px-5 py-2 inline-flex items-center gap-1.5"
            >
              <Plus size={16} />新建实例
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {instances.map((inst) => {
            const style = PHASE_STYLE[inst.phase]
            const active = isActive(inst.phase)
            const pending = busy[inst.name]
            const uptime = inst.phase === 'running' ? formatUptime(inst.startedAt) : undefined
            const isCurrent = current === inst.name

            return (
              <div
                key={inst.name}
                className={`card p-5 flex flex-col gap-4 ${isCurrent ? 'ring-1 ring-pink-500/40' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-semibold text-theme truncate">{inst.name}</h3>
                      {isCurrent && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-pink-500/15 text-pink-600 dark:text-pink-400 font-medium">
                          当前
                        </span>
                      )}
                      {inst.isDefault && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-theme-item text-theme-secondary font-medium">
                          默认
                        </span>
                      )}
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full font-medium ${style.badge}`}>
                        {style.spin
                          ? <Loader2 size={12} className="animate-spin" />
                          : <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />}
                        {style.label}
                      </span>
                    </div>
                    <div className="text-xs text-theme-muted mt-1.5 flex items-center gap-3 flex-wrap">
                      <span>路径：{instanceHref(inst.name)}</span>
                      {inst.pid && <span>PID {inst.pid}</span>}
                      {uptime && <span>已运行 {uptime}</span>}
                    </div>
                  </div>

                  {/* 开机自启开关 */}
                  <label className="flex items-center gap-2 text-xs text-theme-secondary select-none cursor-pointer flex-shrink-0 pt-0.5">
                    <span>自启</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={inst.autostart}
                      disabled={Boolean(pending)}
                      onClick={() => void runAction(
                        inst.name,
                        'autostart',
                        () => patchInstance(inst.name, { autostart: !inst.autostart }),
                      )}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        inst.autostart ? 'bg-pink-500' : 'bg-theme-divider'
                      } ${pending ? 'opacity-60' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                          inst.autostart ? 'translate-x-4.5' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {inst.phase === 'failed' && inst.error && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-900/25 border border-red-200 dark:border-red-800/60 text-xs text-red-600 dark:text-red-400">
                    <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                    <span className="flex-1 break-all">{inst.error}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap pt-1 hairline-t">
                  {inst.phase === 'running' ? (
                    !isCurrent && (
                      <button
                        type="button"
                        onClick={() => switchTo(inst.name)}
                        className="btn-primary text-sm px-3.5 py-1.5 inline-flex items-center gap-1.5"
                      >
                        切换进入<ArrowRight size={15} />
                      </button>
                    )
                  ) : !active ? (
                    <button
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => void runAction(inst.name, 'start', () => startInstance(inst.name), `正在启动 ${inst.name}`)}
                      className="btn-primary text-sm px-3.5 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60"
                    >
                      {pending === 'start' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                      启动
                    </button>
                  ) : (
                    <span className="text-xs text-theme-muted px-2 py-1.5 inline-flex items-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" />
                      {inst.phase === 'starting' ? '等待就绪…' : '正在停止…'}
                    </span>
                  )}

                  {active && inst.phase !== 'stopping' && (
                    <>
                      <button
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={() => void runAction(inst.name, 'restart', () => restartInstance(inst.name), `正在重启 ${inst.name}`)}
                        className="btn-glass text-sm px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60"
                      >
                        {pending === 'restart' ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
                        重启
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={() => void runAction(inst.name, 'stop', () => stopInstance(inst.name), `已停止 ${inst.name}`)}
                        className="btn-glass text-sm px-3 py-1.5 inline-flex items-center gap-1.5 text-red-600 dark:text-red-400 disabled:opacity-60"
                      >
                        {pending === 'stop' ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                        停止
                      </button>
                    </>
                  )}

                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      type="button"
                      onClick={() => setTerminalTarget(inst.name)}
                      title="查看终端日志"
                      className="p-2 rounded-lg text-theme-muted hover:text-theme hover:bg-theme-item transition-colors"
                    >
                      <Terminal size={16} />
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => {
                        setRenamingTarget(inst)
                        setRenameValue(inst.name)
                        setRenameError('')
                      }}
                      title={active ? '重命名实例（会重启该实例）' : '重命名实例'}
                      className="p-2 rounded-lg text-theme-muted hover:text-theme hover:bg-theme-item transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => setDeletingTarget(inst)}
                      title={active ? '删除实例（会先停止该实例）' : '删除实例'}
                      className="p-2 rounded-lg text-theme-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 新建实例 */}
      {showCreate && (
        <Portal>
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
            <div className="absolute inset-0 scrim" onClick={() => !creating && setShowCreate(false)} />
            <form
              onSubmit={handleCreate}
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-instance-title"
              className="relative glass glass-thick glass-dense r-window glass-pop w-full max-w-md"
            >
              <div className="flex items-center justify-between p-5 hairline-b">
                <h3 id="create-instance-title" className="text-lg font-semibold text-theme">新建实例</h3>
                <button type="button" onClick={() => !creating && setShowCreate(false)} className="text-theme-hint hover:text-theme">
                  <X size={20} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                {createError && (
                  <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
                    {createError}
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-theme-secondary mb-1.5">实例名称</label>
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => {
                      setCreateName(e.target.value)
                      setCreateError('')
                    }}
                    placeholder="例如 bot2、qq-work"
                    autoFocus
                    className="input-field"
                  />
                  <p className="text-xs text-theme-muted mt-1.5">字母或数字开头，支持字母、数字、- 和 _，最长 64 字符</p>
                </div>
                <label className="flex items-center gap-2.5 text-sm text-theme cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={createAutostart}
                    onChange={e => setCreateAutostart(e.target.checked)}
                    className="rounded border-theme-divider accent-pink-500"
                  />
                  <span>随管理器一起自动启动</span>
                </label>
                <label className="flex items-center gap-2.5 text-sm text-theme cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={createStartNow}
                    onChange={e => setCreateStartNow(e.target.checked)}
                    className="rounded border-theme-divider accent-pink-500"
                  />
                  <span>创建后立即启动</span>
                </label>
              </div>
              <div className="flex justify-end gap-2.5 p-5 hairline-t">
                <button type="button" disabled={creating} onClick={() => setShowCreate(false)} className="btn-glass px-4 py-2 text-sm">
                  取消
                </button>
                <button type="submit" disabled={creating || !createName.trim()} className="btn-primary px-5 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                  {creating && <Loader2 size={15} className="animate-spin" />}创建
                </button>
              </div>
            </form>
          </div>
        </Portal>
      )}

      {/* 重命名实例 */}
      {renamingTarget && (() => {
        const latest = instances.find(item => item.name === renamingTarget.name) ?? renamingTarget
        const renamingActive = isActive(latest.phase)
        return (
          <Portal>
            <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
              <div className="absolute inset-0 scrim" onClick={() => !renaming && setRenamingTarget(null)} />
              <form
                onSubmit={handleRename}
                role="dialog"
                aria-modal="true"
                aria-labelledby="rename-instance-title"
                className="relative glass glass-thick glass-dense r-window glass-pop w-full max-w-md"
              >
                <div className="flex items-center justify-between p-5 hairline-b">
                  <h3 id="rename-instance-title" className="text-lg font-semibold text-theme">重命名实例「{renamingTarget.name}」</h3>
                  <button type="button" onClick={() => !renaming && setRenamingTarget(null)} className="text-theme-hint hover:text-theme">
                    <X size={20} />
                  </button>
                </div>
                <div className="p-5 space-y-3">
                  {renamingActive && (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/25 border border-amber-200 dark:border-amber-800/60 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
                      <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                      <span>该实例当前正在运行，重命名会先停止实例、迁移数据目录，然后自动重新启动。</span>
                    </div>
                  )}
                  {renameError && (
                    <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
                      {renameError}
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-theme-secondary mb-1.5">新名称</label>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => {
                        setRenameValue(e.target.value)
                        setRenameError('')
                      }}
                      autoFocus
                      className="input-field"
                    />
                    <p className="text-xs text-theme-muted mt-1.5">会同步移动 data/instances/{renamingTarget.name} 目录</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2.5 p-5 hairline-t">
                  <button type="button" disabled={renaming} onClick={() => setRenamingTarget(null)} className="btn-glass px-4 py-2 text-sm">
                    取消
                  </button>
                  <button type="submit" disabled={renaming || !renameValue.trim()} className="btn-primary px-5 py-2 text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                    {renaming && <Loader2 size={15} className="animate-spin" />}
                    {renamingActive ? '重命名并重启' : '确认重命名'}
                  </button>
                </div>
              </form>
            </div>
          </Portal>
        )
      })()}

      {/* 删除实例确认 */}
      {deletingTarget && (() => {
        const latest = instances.find(item => item.name === deletingTarget.name) ?? deletingTarget
        const deletingActive = isActive(latest.phase)
        return (
          <Portal>
            <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
              <div className="absolute inset-0 scrim" onClick={() => !deleting && setDeletingTarget(null)} />
              <div role="dialog" aria-modal="true" aria-labelledby="delete-instance-title" className="relative glass glass-thick glass-dense r-panel glass-pop w-full max-w-sm p-6 space-y-4">
                <h3 id="delete-instance-title" className="text-lg font-semibold text-theme">删除实例「{deletingTarget.name}」</h3>
                {deletingActive && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/25 border border-amber-200 dark:border-amber-800/60 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
                    <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                    <span>该实例当前正在运行，确认删除会先停止实例，再永久删除其数据目录。</span>
                  </div>
                )}
                <p className="text-sm text-theme-secondary">
                  这会永久删除 <code className="px-1 py-0.5 rounded bg-theme-item text-xs">data/instances/{deletingTarget.name}</code> 下的所有配置和数据，且无法恢复。
                </p>
                <div className="flex justify-end gap-2.5 pt-2">
                  <button type="button" autoFocus disabled={deleting} onClick={() => setDeletingTarget(null)} className="btn-glass px-4 py-2 text-sm">
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void handleDelete()}
                    className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors font-medium text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                  >
                    {deleting && <Loader2 size={15} className="animate-spin" />}
                    {deletingActive ? '停止并删除' : '确认删除'}
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        )
      })()}
    </div>
  )
}

export default InstancesPage

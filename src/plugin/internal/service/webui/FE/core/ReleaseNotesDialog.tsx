import React, { useEffect, useState } from 'react'
import { ArrowUpCircle, ExternalLink, FileText, Loader2, RefreshCw, X } from 'lucide-react'
import { Portal } from '../components/common'
import { Lightbox, LightboxImage } from '../components/common/Lightbox'
import { Markdown } from '../components/common/Markdown'
import { apiFetch } from '../utils/api'
import { releasePageUrl, useCoreUpdateStore, type ReleaseNotes } from '../stores/coreUpdateStore'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function formatPublishedAt(iso?: string): string | undefined {
  if (!iso) return
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const ReleaseNotesDialog: React.FC = () => {
  const version = useCoreUpdateStore(state => state.releaseNotesVersion)
  const close = useCoreUpdateStore(state => state.closeReleaseNotes)
  const status = useCoreUpdateStore(state => state.status)
  const target = useCoreUpdateStore(state => state.target)
  const startUpdate = useCoreUpdateStore(state => state.startUpdate)

  const [result, setResult] = useState<{ version: string; notes?: ReleaseNotes; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [viewing, setViewing] = useState<{ images: LightboxImage[]; index: number } | null>(null)

  useEffect(() => {
    if (!version) return
    let alive = true
    setResult(null)
    setConfirming(false)
    setViewing(null)
    apiFetch<ReleaseNotes>(`/api/core-update/release-notes?version=${encodeURIComponent(version)}`)
      .then(response => {
        if (alive) setResult({ version, notes: response.data })
      })
      .catch(error => {
        if (alive) setResult({ version, error: errorText(error) })
      })
    return () => { alive = false }
  }, [version, attempt])

  useEffect(() => {
    if (!version) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version, close])

  if (!version) return null

  const notes = result?.version === version ? result.notes : undefined
  const error = result?.version === version ? result.error : undefined
  const loading = !notes && !error
  const githubUrl = notes?.url ?? releasePageUrl(version)
  const published = formatPublishedAt(notes?.publishedAt)
  const canUpdate = !!status?.available && status.latest === version && status.state === 'idle' && !target

  const handleConfirmUpdate = () => {
    setConfirming(false)
    close()
    void startUpdate(version)
  }

  return (
    <Portal>
      <div className="fixed inset-0 scrim flex items-center justify-center p-4" style={{ zIndex: 9000 }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`v${version} 更新日志`}
          className="glass glass-thick r-window glass-pop w-full max-w-2xl max-h-[85vh] flex flex-col"
        >
          <div className="flex shrink-0 items-start gap-3 p-4 sm:gap-4 sm:p-6 hairline-b">
            <div className="w-11 h-11 shrink-0 rounded-2xl gradient-primary-br flex items-center justify-center">
              <FileText size={22} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-theme break-words">
                {notes?.title || `v${version} 更新日志`}
              </h3>
              <p className="text-xs text-theme-hint mt-0.5">
                Lucky Lillia Bot v{version}
                {published && ` · 发布于 ${published}`}
              </p>
            </div>
            <button
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={close}
              className="p-2 -m-2 text-theme-hint hover:text-theme transition-colors"
            >
              <X size={22} />
            </button>
          </div>

          <div className="p-4 sm:p-6 overflow-y-auto flex-1">
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-theme-secondary">
                <Loader2 size={28} className="animate-spin text-pink-500" />
                <span>正在从 GitHub 获取更新日志…</span>
              </div>
            )}

            {error && (
              <div role="alert" className="py-6 space-y-4">
                <p className="text-sm text-red-500 break-words">读取更新日志失败：{error}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAttempt(value => value + 1)}
                    className="btn-glass text-sm flex items-center gap-1.5"
                  >
                    <RefreshCw size={15} />重试
                  </button>
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary text-sm inline-flex items-center gap-1.5"
                  >
                    <ExternalLink size={15} />前往 GitHub 查看
                  </a>
                </div>
              </div>
            )}

            {notes && (
              notes.body.trim() ? (
                <Markdown
                  source={notes.body}
                  onImage={(url, alt) => setViewing({ images: [{ url, caption: alt || undefined }], index: 0 })}
                />
              ) : (
                <p className="text-sm text-theme-muted py-4">该版本暂未填写更新说明。</p>
              )
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 hairline-t">
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-pink-500 hover:underline inline-flex items-center gap-1.5"
            >
              <ExternalLink size={15} />在 GitHub 查看
            </a>

            <div className="flex flex-wrap items-center gap-2">
              {canUpdate && (confirming ? (
                <>
                  <span className="text-xs text-theme-secondary">更新后 Bot 会自动重启，期间消息收发会中断一会儿</span>
                  <button type="button" onClick={handleConfirmUpdate} className="btn-primary text-sm">确认更新</button>
                  <button type="button" onClick={() => setConfirming(false)} className="btn-glass text-sm">取消</button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="btn-primary text-sm flex items-center gap-1.5"
                >
                  <ArrowUpCircle size={16} />立即更新
                </button>
              ))}
              {!confirming && (
                <button type="button" onClick={close} className="btn-glass text-sm">关闭</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {viewing && (
        <Lightbox
          images={viewing.images}
          index={viewing.index}
          onIndex={index => setViewing(prev => prev && { ...prev, index })}
          onClose={() => setViewing(null)}
        />
      )}
    </Portal>
  )
}

export default ReleaseNotesDialog

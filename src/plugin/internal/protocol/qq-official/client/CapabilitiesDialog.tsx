import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, MessageSquare, Send, Settings, ShieldCheck, X } from 'lucide-react'
import { Lightbox, type LightboxImage } from '@luckylillia-dev/plugin-sdk/webui'
import groupBotProfileImg from './assets/group-bot-profile.jpg'
import groupBotSettingsImg from './assets/group-bot-settings.jpg'

export const CAPABILITIES_ACK_KEY = 'llbot-qq-official-capabilities-ack'

export function hasAcknowledgedCapabilities(storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): boolean {
  if (!storage) return false
  try {
    return storage.getItem(CAPABILITIES_ACK_KEY) === '1'
  } catch {
    return false
  }
}

export function acknowledgeCapabilities(storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return
  try {
    storage.setItem(CAPABILITIES_ACK_KEY, '1')
  } catch {
    // Private browsing or quota full
  }
}

interface CapabilitiesDialogProps {
  onClose(): void
  onAcknowledge?(): void
}

const GUIDE_IMAGES: LightboxImage[] = [
  { url: groupBotProfileImg, caption: '1. 在群里点击机器人头像，再点击右上角齿轮图标' },
  { url: groupBotSettingsImg, caption: '2. 进入设置页，配置群聊消息范围（仅群主可设）与主动发言' },
]

const CapabilitiesDialog: React.FC<CapabilitiesDialogProps> = ({ onClose, onAcknowledge }) => {
  const [viewingIndex, setViewingIndex] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <div
        className="fixed inset-0 scrim flex items-center justify-center p-4"
        style={{ zIndex: 9000 }}
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="QQ 官方机器人能力说明"
          className="glass glass-thick r-window glass-pop w-full max-w-2xl max-h-[85vh] flex flex-col"
          onClick={event => event.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-3 p-4 sm:gap-4 sm:p-6 hairline-b">
            <div className="w-11 h-11 shrink-0 rounded-2xl gradient-primary-br flex items-center justify-center">
              <Bot size={22} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-theme">QQ 官方机器人能力说明</h3>
              <p className="text-xs text-theme-hint mt-0.5">使用 QQ 开放平台官方机器人前建议了解以下规则与群内设置</p>
            </div>
            <button
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={onClose}
              className="p-2 -m-2 text-theme-hint hover:text-theme transition-colors"
            >
              <X size={22} />
            </button>
          </div>

          <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 text-sm text-theme-secondary leading-relaxed">
            <section className="rounded-xl bg-theme-item/60 p-4 space-y-1.5">
              <h4 className="flex items-center gap-2 font-semibold text-theme">
                <ShieldCheck size={17} className="text-pink-500 shrink-0" />
                入群与好友权限
              </h4>
              <p>
                个人认证的开发者只能将机器人邀请到<strong className="font-semibold text-theme">自己是群主或管理员</strong>的群聊中；<strong className="font-semibold text-theme">企业认证的机器人</strong>可随意被添加好友和入群。
              </p>
            </section>

            <section className="rounded-xl bg-theme-item/60 p-4 space-y-1.5">
              <h4 className="flex items-center gap-2 font-semibold text-theme">
                <MessageSquare size={17} className="text-pink-500 shrink-0" />
                接收全量消息（免 @ 触发）
              </h4>
              <p>
                默认只接收 <strong className="font-semibold text-theme">@机器人</strong> 的消息；如果希望机器人无需 @ 也能收到群聊消息，需要在群内将「机器人可获取的群聊消息范围」设置为<strong className="font-semibold text-theme">获取群内全部消息</strong>。
                注意：<strong className="font-semibold text-theme">免 @ 获取全量消息只能由群主设置</strong>。
              </p>
            </section>

            <section className="rounded-xl bg-theme-item/60 p-4 space-y-1.5">
              <h4 className="flex items-center gap-2 font-semibold text-theme">
                <Send size={17} className="text-pink-500 shrink-0" />
                主动发送消息
              </h4>
              <p>
                默认仅支持<strong className="font-semibold text-theme">被动回复</strong>，需要有人发送消息后机器人才能回复；如果需要机器人主动向群里发消息（如定时提醒、推送通知等），需要在群内开启<strong className="font-semibold text-theme">机器人主动在群聊内发言</strong>。
              </p>
            </section>

            <section className="rounded-xl bg-theme-item/60 p-4 space-y-3">
              <div className="space-y-1">
                <h4 className="flex items-center gap-2 font-semibold text-theme">
                  <Settings size={17} className="text-pink-500 shrink-0" />
                  群内设置路径
                </h4>
                <p>
                  在群聊中<strong className="font-semibold text-theme">点击机器人头像</strong> → 点击右上角<strong className="font-semibold text-theme">齿轮图标</strong>，即可进入设置页配置上述两项（点击图片可放大查看）。
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {GUIDE_IMAGES.map((image, index) => (
                  <figure key={image.url} className="space-y-1.5">
                    <button
                      type="button"
                      title="点击放大"
                      onClick={() => setViewingIndex(index)}
                      className="block w-full rounded-xl overflow-hidden border border-theme-divider bg-black/5 dark:bg-white/5 hover:opacity-90 transition-opacity cursor-zoom-in"
                    >
                      <img
                        src={image.url}
                        alt={image.caption}
                        loading="lazy"
                        className="w-full h-44 object-contain bg-white/80 dark:bg-black/20"
                      />
                    </button>
                    <figcaption className="text-xs text-theme-muted leading-snug">{image.caption}</figcaption>
                  </figure>
                ))}
              </div>
            </section>
          </div>

          <div className="flex shrink-0 justify-end px-4 py-3 sm:px-6 sm:py-4 hairline-t">
            <button type="button" onClick={onAcknowledge ?? onClose} className="btn-primary text-sm">我知道了</button>
          </div>
        </div>
      </div>

      {viewingIndex !== null && (
        <Lightbox
          images={GUIDE_IMAGES}
          index={viewingIndex}
          onIndex={setViewingIndex}
          onClose={() => setViewingIndex(null)}
        />
      )}
    </>,
    document.body,
  )
}

export default CapabilitiesDialog

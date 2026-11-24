import React, { useEffect, useState } from 'react'
import { KeyRound, Loader2, Lock } from 'lucide-react'
import { HostSelector } from '../common/HostSelector'
import { showToast } from '../common/Toast'
import ChangePasswordDialog from './ChangePasswordDialog'
import { ResConfig } from '../../types'
import { apiFetch } from '../../utils/api'
import { useManagerStore } from '../../stores/managerStore'
import { getGatewaySettings, saveGatewaySettings } from '../../utils/managerApi'
import { type EnvLock, lockedBy, webuiPatch } from './webuiPatch'

const DEFAULT_PORT = 3080

const LockedHint: React.FC<{ text: string }> = ({ text }) => (
  <p className='text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1'>
    <Lock size={12} />{text}
  </p>
)

interface LoadedWebuiSettings {
  host: string
  port: number
  listening?: number
  envLocked: EnvLock[]
}

/**
 * The WebUI's own connection settings: listens on the manager's unified gateway when running under
 * llbot-manager.js, or on the standalone instance's settings.json when run with --no-manager / --no-supervisor.
 */
const WebuiSettings: React.FC = () => {
  const managerStatus = useManagerStore(state => state.status)
  const managed = managerStatus === 'managed'
  const [loaded, setLoaded] = useState<LoadedWebuiSettings | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(DEFAULT_PORT)
  const [saving, setSaving] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  useEffect(() => {
    if (managerStatus === 'unknown') return
    let cancelled = false
    const load = async () => {
      try {
        if (managed) {
          const data = await getGatewaySettings()
          if (cancelled) return
          setLoaded({ host: data.host, port: data.port, listening: data.listening, envLocked: data.envLocked })
          setHost(data.host)
          setPort(data.port || DEFAULT_PORT)
        } else {
          const res = await apiFetch<ResConfig>('/api/config')
          if (cancelled) return
          const savedHost = res.data.config.webui?.host ?? ''
          const savedPort = res.data.config.webui?.port || DEFAULT_PORT
          setLoaded({ host: savedHost, port: savedPort, envLocked: res.data.envLocked })
          setHost(savedHost)
          setPort(savedPort)
        }
      } catch (e) {
        if (!cancelled) showToast(e instanceof Error ? e.message : String(e), 'error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [managerStatus, managed])

  if (!loaded) return <div className='flex justify-center py-4'><Loader2 size={24} className='animate-spin text-pink-500' /></div>

  const lockOf = (path: string) => loaded.envLocked.find(lock => lock.path === path)
  const hostLock = lockOf('webui.host')
  const portLock = lockOf('webui.port')
  const changed = (!hostLock && host !== loaded.host) || (!portLock && port !== loaded.port)

  const save = async () => {
    setSaving(true)
    try {
      const patch = webuiPatch({ host, port }, loaded.envLocked)
      if (managed) {
        const next = await saveGatewaySettings(patch)
        const moved = patch.port !== undefined && patch.port !== loaded.port
        setLoaded({ host: next.host, port: next.port, listening: next.listening, envLocked: next.envLocked })
        showToast(moved ? `已保存，WebUI 改到端口 ${patch.port}，要用新端口重新打开` : '已保存，WebUI 网关会重新监听', 'success')
      } else {
        const res = await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { webui: patch } }),
        })
        if (!res.success) throw new Error(res.message || '保存失败')
        const moved = patch.port !== undefined && patch.port !== loaded.port
        setLoaded({
          ...loaded,
          host: patch.host ?? loaded.host,
          port: patch.port ?? loaded.port,
        })
        showToast(moved ? `已保存，WebUI 改到端口 ${patch.port}，要用新端口重新打开` : '已保存，WebUI 会重新启动', 'success')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='space-y-4'>
      {managed && (
        <p className='text-xs text-theme-muted'>
          所有实例共用同一个监听地址、端口和访问密码
          {loaded.listening && loaded.listening !== loaded.port ? `（当前实际监听端口 ${loaded.listening}）` : ''}
        </p>
      )}
      <div>
        <div className='text-sm text-theme-secondary mb-1.5'>监听地址</div>
        {hostLock
          ? <><input type='text' value={loaded.host || '全部 (0.0.0.0 和 ::)'} disabled className='input-field opacity-70 cursor-not-allowed' /><LockedHint text={lockedBy(hostLock)} /></>
          : <HostSelector value={host} onChange={setHost} interfacesUrl={managed ? '/api/manager/network-interfaces' : undefined} />}
      </div>
      <div>
        <div className='text-sm text-theme-secondary mb-1.5'>端口</div>
        <input
          type='number'
          min={1}
          max={65535}
          value={portLock ? loaded.port : port}
          disabled={!!portLock}
          onChange={e => setPort(parseInt(e.target.value) || 0)}
          className={`input-field ${portLock ? 'opacity-70 cursor-not-allowed' : ''}`}
        />
        {portLock && <LockedHint text={lockedBy(portLock)} />}
      </div>
      {changed && (
        <div className='flex items-center justify-end gap-3'>
          <span className='text-xs text-theme-muted'>{managed ? '保存后网关会重新监听' : '保存后 WebUI 会重新启动'}</span>
          <button onClick={save} disabled={saving || !(port >= 1 && port <= 65535)} className='btn-primary text-sm px-4 py-1.5 flex items-center gap-1.5'>
            {saving && <Loader2 size={16} className='animate-spin' />}保存
          </button>
        </div>
      )}
      <div className='flex items-center gap-3'>
        <KeyRound size={18} className='text-theme-muted flex-shrink-0' />
        <span className='flex-1 text-sm text-theme'>{managed ? '统一访问密码' : '访问密码'}</span>
        <button onClick={() => setChangingPassword(true)} className='btn-glass text-sm px-4 py-1.5'>修改密码</button>
      </div>
      <ChangePasswordDialog
        visible={changingPassword}
        onClose={() => setChangingPassword(false)}
        // set-token does not answer with the new token: a reload asks for it
        onSuccess={() => window.location.reload()}
      />
    </div>
  )
}

export default WebuiSettings

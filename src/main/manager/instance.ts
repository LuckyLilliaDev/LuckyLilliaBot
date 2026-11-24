import { fork, type ChildProcess } from 'node:child_process'
import { RESTART_EXIT_CODE, SUPERVISED_ENV } from '../restart'
import { GATEWAY_SECRET_ENV, isInstanceMessage, MANAGED_ENV, type InstanceMessage, type ManagerMessage } from './protocol'

export type InstancePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface InstanceStatus {
  name: string
  phase: InstancePhase
  pid?: number
  /** The instance's WebUI on 127.0.0.1, once it reported it */
  webuiPort?: number
  /** The last exit, if it exited */
  exitCode?: number | null
  /** Why it is failed: kept crashing */
  error?: string
  startedAt?: number
}

export interface InstanceProcessOptions {
  /** llbot-core.js, or src/main/main.ts in development */
  core: string
  /** Node's own options; process.execArgv by default, so a tsx loader carries over in development */
  execArgv?: readonly string[]
  /** Arguments for this instance; `--instance <name>` and `--parent-pid` are added */
  args: () => readonly string[]
  env?: NodeJS.ProcessEnv
  secret: string
  /** A complete line of the instance's output */
  output?: (name: string, line: string, stream: 'stdout' | 'stderr') => void
  onChange?: (status: InstanceStatus) => void
  /** IPC messages from the instance other than the built-in `webui` ready message */
  onMessage?: (name: string, message: InstanceMessage) => void
  /** Called when the current child process exits (before any restart backoff) */
  onExit?: (name: string) => void
  /** Restarts after crashes allowed within a minute before it is marked failed */
  maxRestarts?: number
  /** Before a stopping instance is killed */
  stopTimeout?: number
  log?: (message: string) => void
}

const RESTART_WINDOW = 60_000
const MAX_BACKOFF = 30_000
const LOG_LINES = 300

/**
 * One instance: llbot-core.js forked with an IPC channel. Started again when it asks for a restart (after an update
 * of its plugins) or crashes, with backoff; marked failed when it keeps crashing.
 */
export class InstanceProcess {
  private child?: ChildProcess
  private phase: InstancePhase = 'stopped'
  private webuiPort?: number
  private exitCode?: number | null
  private error?: string
  private startedAt?: number
  private crashes: number[] = []
  private retry?: NodeJS.Timeout
  private exited?: Promise<void>
  private readonly lines: string[] = []

  constructor(readonly name: string, private readonly options: InstanceProcessOptions) {}

  status(): InstanceStatus {
    return {
      name: this.name,
      phase: this.phase,
      ...this.child?.pid ? { pid: this.child.pid } : {},
      ...this.webuiPort ? { webuiPort: this.webuiPort } : {},
      ...this.exitCode !== undefined ? { exitCode: this.exitCode } : {},
      ...this.error ? { error: this.error } : {},
      ...this.startedAt ? { startedAt: this.startedAt } : {},
    }
  }

  /** The last lines of its output, for the WebUI when it failed to start */
  recentOutput(): string[] {
    return [...this.lines]
  }

  get running(): boolean {
    return this.phase === 'starting' || this.phase === 'running'
  }

  start(): void {
    if (this.child || this.phase === 'stopping') return
    clearTimeout(this.retry)
    this.retry = undefined
    this.error = undefined
    this.crashes = this.phase === 'failed' ? [] : this.crashes
    this.spawn()
  }

  /** Asks it to shut down cleanly; kills it when it has not exited after the stop timeout */
  async stop(timeout = this.options.stopTimeout ?? 25_000): Promise<void> {
    clearTimeout(this.retry)
    this.retry = undefined
    const child = this.child
    if (!child) {
      if (this.phase !== 'stopped') this.set('stopped')
      return
    }
    if (this.phase !== 'stopping') {
      this.set('stopping')
      this.send({ type: 'shutdown' })
    }
    const timer = setTimeout(() => {
      this.options.log?.(`实例 ${this.name} 在 ${Math.round(timeout / 1000)} 秒内没有退出，强制结束`)
      child.kill('SIGKILL')
    }, timeout)
    try {
      await this.exited
    } finally {
      clearTimeout(timer)
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    this.start()
  }

  /** Sends an IPC message to the running child; returns false if no connected child exists */
  sendMessage(message: ManagerMessage): boolean {
    const child = this.child
    if (!child?.connected) return false
    child.send(message, () => {})
    return true
  }

  private spawn() {
    this.webuiPort = undefined
    this.exitCode = undefined
    this.startedAt = Date.now()
    const env: NodeJS.ProcessEnv = {
      ...this.options.env ?? process.env,
      [MANAGED_ENV]: '1',
      // It may ask for a restart (requestRestart() checks this)
      [SUPERVISED_ENV]: '1',
      [GATEWAY_SECRET_ENV]: this.options.secret,
      // Its WebUI is only reached through the gateway; the values also show as fixed on its settings page
      LLBOT_WEBUI_HOST: '127.0.0.1',
      LLBOT_WEBUI_PORT: '0',
    }
    // The name comes from --instance; one the manager was started with does not apply to every instance
    delete env.LLBOT_INSTANCE
    // Its output goes through a pipe now: keep the colours a terminal would have shown
    if (env.FORCE_COLOR === undefined && process.stdout.isTTY) env.FORCE_COLOR = '1'
    const child = fork(this.options.core, [
      ...this.options.args(),
      '--instance', this.name,
      `--parent-pid=${process.pid}`,
    ], {
      execArgv: [...this.options.execArgv ?? process.execArgv],
      env,
      // Windows: fork attaches it to the manager's console, so a launcher's Ctrl+C there also reaches it as before
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    this.set('starting')
    this.pipe(child.stdout, 'stdout')
    this.pipe(child.stderr, 'stderr')
    child.on('message', (message) => {
      if (!isInstanceMessage(message) || child !== this.child) return
      if (message.type === 'webui') {
        this.webuiPort = message.port
        if (this.phase === 'starting') this.set('running')
        else this.options.onChange?.(this.status())
      } else {
        this.options.onMessage?.(this.name, message)
      }
    })
    let resolveExit!: () => void
    this.exited = new Promise(resolve => { resolveExit = resolve })
    child.once('error', (error) => {
      this.options.log?.(`无法启动实例 ${this.name}：${error.message}`)
    })
    child.once('exit', (code, signal) => {
      this.child = undefined
      this.webuiPort = undefined
      this.exitCode = code
      this.options.onExit?.(this.name)
      resolveExit()
      this.exitedWith(code, signal)
    })
  }

  private exitedWith(code: number | null, signal: NodeJS.Signals | null) {
    if (this.phase === 'stopping') {
      this.set('stopped')
      return
    }
    if (code === RESTART_EXIT_CODE) {
      // It asked for this, e.g. after a plugin update: not a crash, but still not endlessly
      if (this.countCrash()) this.spawn()
      return
    }
    if (code === 0) {
      this.set('stopped')
      return
    }
    if (!this.countCrash()) return
    const attempt = this.crashes.length
    const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF)
    this.options.log?.(`实例 ${this.name} 意外退出（${code ?? signal}），${Math.round(delay / 1000)} 秒后重启`)
    this.set('starting')
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (this.phase === 'starting' && !this.child) this.spawn()
    }, delay)
  }

  /** Counts a restart; false, marking it failed, when there were too many within a minute */
  private countCrash(): boolean {
    const now = Date.now()
    this.crashes = this.crashes.filter(time => now - time < RESTART_WINDOW)
    this.crashes.push(now)
    if (this.crashes.length > (this.options.maxRestarts ?? 5)) {
      this.error = `一分钟内退出了 ${this.crashes.length} 次，已停止自动重启`
      this.options.log?.(`实例 ${this.name} ${this.error}`)
      this.set('failed')
      return false
    }
    return true
  }

  private send(message: ManagerMessage) {
    const child = this.child
    if (!child?.connected) {
      // No channel any more: a signal does the same
      child?.kill('SIGTERM')
      return
    }
    child.send(message, (error) => {
      if (error) child.kill('SIGTERM')
    })
  }

  private set(phase: InstancePhase) {
    this.phase = phase
    this.options.onChange?.(this.status())
  }

  private pipe(stream: NodeJS.ReadableStream | null, kind: 'stdout' | 'stderr') {
    if (!stream) return
    let rest = ''
    const emit = (line: string) => {
      this.lines.push(line)
      if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES)
      this.options.output?.(this.name, line, kind)
    }
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const part of parts) emit(part.endsWith('\r') ? part.slice(0, -1) : part)
    })
    stream.on('end', () => {
      if (rest) emit(rest)
      rest = ''
    })
  }
}

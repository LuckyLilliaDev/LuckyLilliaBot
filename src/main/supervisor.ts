import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:os'
import { parentPidOf, RESTART_EXIT_CODE, SUPERVISED_ENV, withoutParentPid } from './restart'

/** What to start: the bot's entry, and whether it is the release a container installed into its data volume */
export interface CoreChoice {
  core: string
  runtime?: { version: string }
  /** Said in the log when it is chosen */
  note?: string
}

export interface SuperviseOptions {
  /** The bot's entry, llbot-core.js next to llbot.js; used when `choose` is not given */
  core?: string
  /** Picks the entry on every start, so a restart after an update starts what is installed now */
  choose?: () => CoreChoice
  /** A data-volume release kept crashing at startup: set it aside; returns where it went */
  onRuntimeFailed?: (choice: CoreChoice) => string
  /** The arguments llbot.js was given */
  args: readonly string[]
  /** Node's own options, e.g. --enable-source-maps; process.execArgv by default */
  execArgv?: readonly string[]
  /** Restarts allowed within a minute before the supervisor gives up on a bot that keeps asking */
  maxRestarts?: number
  log?: (message: string) => void
}

const RESTART_WINDOW = 60_000
/** A data-volume release that exits on its own sooner than this after starting failed to start */
const STARTUP_WINDOW = 60_000
/** Failed starts in a row of a data-volume release before the image's own version takes over */
const MAX_FAILED_STARTS = 3

/**
 * Runs the bot as a child and starts it again when it exits with RESTART_EXIT_CODE, e.g. after an update replaced
 * its files. Whatever started llbot.js keeps this process: its pid, its console and the bot's exit code, so the CLI
 * launcher, the desktop app and Docker see no difference.
 *
 * The bot gets this process as its --parent-pid and stops on its own when this one is gone; this process watches
 * the --parent-pid it was given and leaves when that one is gone.
 *
 * A release a container installed into its data volume survives recreating the container, so one that cannot
 * start would otherwise keep the container down for good: after failing to start three times in a row it is set
 * aside and the image's own version starts instead.
 */
export function supervise(options: SuperviseOptions): void {
  const log = options.log ?? (message => console.log(`[supervisor] ${message}`))
  const choose: () => CoreChoice = options.choose ?? (() => ({ core: options.core! }))
  const maxRestarts = options.maxRestarts ?? 5
  const posix = process.platform !== 'win32'
  const parent = parentPidOf(options.args)
  const restarts: number[] = []
  let failedStarts = 0
  let child: ChildProcess | undefined
  let stopping = false

  const start = () => {
    const choice = choose()
    if (choice.note) log(choice.note)
    if (choice.runtime) log(`启动自动更新安装的 ${choice.runtime.version}`)
    const startedAt = Date.now()
    const current = spawn(process.execPath, [
      ...options.execArgv ?? process.execArgv,
      choice.core,
      ...withoutParentPid(options.args),
      `--parent-pid=${process.pid}`,
    ], {
      stdio: 'inherit',
      env: { ...process.env, [SUPERVISED_ENV]: '1' },
      // POSIX: a process group of its own, so a terminal's Ctrl+C reaches this process alone and is passed on
      // once; a second Ctrl+C still forces the bot down. Windows: a console's Ctrl+C reaches every process on it,
      // the bot included, and a group of its own would take a console of its own.
      detached: posix,
    })
    child = current
    current.once('error', (error) => {
      log(`无法启动 Bot：${error.message}`)
      process.exit(1)
    })
    current.once('exit', (code, signal) => {
      child = undefined
      if (code === RESTART_EXIT_CODE) {
        // Asked to stop meanwhile: the restart is moot, and the launcher should not see an unusual exit code
        if (stopping) process.exit(0)
        failedStarts = 0
        const now = Date.now()
        restarts.push(now)
        while (now - restarts[0] > RESTART_WINDOW) restarts.shift()
        if (restarts.length > maxRestarts) {
          log(`Bot 在一分钟内要求重启 ${restarts.length} 次，不再重启`)
          process.exit(1)
        }
        log('正在重启 Bot')
        start()
        return
      }
      if (choice.runtime && !stopping && code !== 0 && Date.now() - startedAt < STARTUP_WINDOW) {
        failedStarts++
        if (failedStarts < MAX_FAILED_STARTS) {
          log(`自动更新安装的 ${choice.runtime.version} 启动后很快退出（退出码 ${code ?? signal}），第 ${failedStarts} 次，稍后重试`)
          setTimeout(start, 1000)
          return
        }
        failedStarts = 0
        let where = ''
        try {
          where = options.onRuntimeFailed?.(choice) ?? ''
        } catch (error) {
          log(`无法移走自动更新安装的版本：${(error as Error).message}`)
          process.exit(code ?? 1)
        }
        log(`自动更新安装的 ${choice.runtime.version} 连续 ${MAX_FAILED_STARTS} 次启动失败，已移到 ${where}，改用自带的版本。` +
          '配置可能已被新版本迁移过；问题解决后可以在「关于」页重新更新')
        start()
        return
      }
      process.exit(code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0))
    })
  }

  const stop = (signal: NodeJS.Signals) => {
    stopping = true
    // On Windows the console delivered the same Ctrl+C to the bot already
    if (posix) child?.kill(signal)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  // A closed terminal hangs up this process group only, not the bot's
  if (posix) process.on('SIGHUP', () => stop('SIGTERM'))

  if (!Number.isNaN(parent)) {
    const timer = setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
        clearInterval(timer)
        // The bot watches this process and shuts down cleanly once it is gone
        stopping = true
        process.exit(0)
      }
    }, 1000)
    timer.unref()
  }

  start()
}

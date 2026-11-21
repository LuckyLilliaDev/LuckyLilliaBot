import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:os'
import { parentPidOf, RESTART_EXIT_CODE, SUPERVISED_ENV, withoutParentPid } from './restart'

export interface SuperviseOptions {
  /** The bot's entry, llbot-core.js next to llbot.js */
  core: string
  /** The arguments llbot.js was given */
  args: readonly string[]
  /** Node's own options, e.g. --enable-source-maps; process.execArgv by default */
  execArgv?: readonly string[]
  /** Restarts allowed within a minute before the supervisor gives up on a bot that keeps asking */
  maxRestarts?: number
  log?: (message: string) => void
}

const RESTART_WINDOW = 60_000

/**
 * Runs the bot as a child and starts it again when it exits with RESTART_EXIT_CODE, e.g. after an update replaced
 * its files. Whatever started llbot.js keeps this process: its pid, its console and the bot's exit code, so the CLI
 * launcher, the desktop app and Docker see no difference.
 *
 * The bot gets this process as its --parent-pid and stops on its own when this one is gone; this process watches
 * the --parent-pid it was given and leaves when that one is gone.
 */
export function supervise(options: SuperviseOptions): void {
  const log = options.log ?? (message => console.log(`[supervisor] ${message}`))
  const maxRestarts = options.maxRestarts ?? 5
  const posix = process.platform !== 'win32'
  const parent = parentPidOf(options.args)
  const childArgs = [
    ...options.execArgv ?? process.execArgv,
    options.core,
    ...withoutParentPid(options.args),
    `--parent-pid=${process.pid}`,
  ]
  const restarts: number[] = []
  let child: ChildProcess | undefined
  let stopping = false

  const start = () => {
    const current = spawn(process.execPath, childArgs, {
      stdio: 'inherit',
      env: { ...process.env, [SUPERVISED_ENV]: '1' },
      // POSIX: a process group of its own, so a terminal's Ctrl+C reaches this process alone and is passed on
      // once; a second Ctrl+C still forces the bot down. Windows: a console's Ctrl+C reaches every process on it,
      // the bot included, and a group of its own would take a console of its own.
      detached: posix,
    })
    child = current
    current.once('error', (error) => {
      log(`cannot start the bot: ${error.message}`)
      process.exit(1)
    })
    current.once('exit', (code, signal) => {
      child = undefined
      if (code === RESTART_EXIT_CODE) {
        // Asked to stop meanwhile: the restart is moot, and the launcher should not see an unusual exit code
        if (stopping) process.exit(0)
        const now = Date.now()
        restarts.push(now)
        while (now - restarts[0] > RESTART_WINDOW) restarts.shift()
        if (restarts.length > maxRestarts) {
          log(`the bot asked for ${restarts.length} restarts within a minute; giving up`)
          process.exit(1)
        }
        log('restarting the bot')
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

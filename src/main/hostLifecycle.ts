import { isSupervised, parentPidOf, RESTART_EXIT_CODE } from './restart'

let restart: (() => void) | undefined

/** One host shutdown path: signals and the parent's death both await plugin disposal. */
export function installHostLifecycle(dispose: () => Promise<void>, log: (error: unknown) => void): () => Promise<void> {
  let stopping: Promise<void> | undefined
  let parentTimer: NodeJS.Timeout | undefined
  const stop = () => stopping ??= (async () => {
    if (parentTimer) clearInterval(parentTimer)
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
    await dispose()
  })()
  const exitAfterStop = (code: number) => { void stop().then(() => process.exit(code), error => { log(error); process.exit(1) }) }
  const requestStop = () => exitAfterStop(0)
  restart = () => exitAfterStop(RESTART_EXIT_CODE)
  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)
  const parent = parentPidOf(process.argv)
  if (!Number.isNaN(parent) && parent !== process.pid) {
    parentTimer = setInterval(() => {
      try { process.kill(parent, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') requestStop()
      }
    }, 1000)
    parentTimer.unref()
  }
  return stop
}

/** Whether requestRestart() can bring the bot back: only a supervisor (llbot.js) starts it again. */
export const canRestart = (): boolean => isSupervised() && restart !== undefined

/**
 * Shuts the bot down like a stop and has the supervisor start it again. False, doing nothing, when no supervisor
 * runs it (`--no-supervisor`, or the source tree in development).
 */
export function requestRestart(): boolean {
  if (!canRestart()) return false
  restart!()
  return true
}

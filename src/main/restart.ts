/**
 * What the supervisor (llbot.js) and the bot it runs (llbot-core.js) agree on. No imports: the supervisor bundle
 * must stay small, and this module is all it shares with the bot.
 */

/** The bot exits with this to be started again, e.g. after its files were updated. EX_TEMPFAIL. */
export const RESTART_EXIT_CODE = 75

/** Set in the bot's environment when a supervisor runs it, so it may ask for a restart. */
export const SUPERVISED_ENV = 'LLBOT_SUPERVISED'

export const isSupervised = (env: NodeJS.ProcessEnv = process.env): boolean => env[SUPERVISED_ENV] === '1'

/** The first --parent-pid wins, as --parent-pid=<pid> or --parent-pid <pid>; NaN without a valid one. */
export function parentPidOf(argv: readonly string[]): number {
  const index = argv.findIndex(arg => arg === '--parent-pid' || arg.startsWith('--parent-pid='))
  const arg = argv[index]
  const value = arg === '--parent-pid' ? argv[index + 1] : arg?.slice('--parent-pid='.length)
  const pid = value && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(pid) && pid > 0 ? pid : NaN
}

/** The arguments without any --parent-pid, in either form */
export function withoutParentPid(argv: readonly string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--parent-pid') {
      i++
      continue
    }
    if (argv[i].startsWith('--parent-pid=')) continue
    result.push(argv[i])
  }
  return result
}

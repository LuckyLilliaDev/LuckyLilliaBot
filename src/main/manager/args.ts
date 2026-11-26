/**
 * How the arguments llbot.js was given are split between the manager and the instances it runs. The launchers
 * (desktop app, CLI, Docker) keep passing what they passed when each process was one instance.
 *
 * Only the bot's own arguments are known here. Anything else belongs to the plugins (a protocol plugin's login
 * mode, `--plugin` to install one) and goes to the instance the launch names, as it did when that was the only one.
 */

/** The manager's own: the WebUI port is the gateway's, the parent is the manager's */
const MANAGER_VALUE = new Set(['--webui-port', '--parent-pid', '--instance'])

/** The bot's own settings for every instance; `--plugin-dir` takes a value */
const SHARED_VALUE = new Set(['--plugin-dir'])
const SHARED_FLAG = new Set(['--plugin-hmr', '--dev', '--debug'])

export interface SplitArgs {
  /** `--webui-port`, if given and a valid port */
  webuiPort?: number
  /** For the target instance only (`--instance`, else the one `-q` picks, else default) */
  target: string[]
  /** For every instance */
  shared: string[]
}

const nameOf = (arg: string) => (arg.startsWith('-') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg)

/** Whether `arg` at `index` is followed by its value as a separate argument */
const takesNext = (argv: readonly string[], index: number) => argv[index + 1] !== undefined && !argv[index + 1].startsWith('-')

export function splitArgs(argv: readonly string[]): SplitArgs {
  const result: SplitArgs = { target: [], shared: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // The desktop app passes its arguments after `--`; they mean the same
    if (arg === '--') continue
    const name = nameOf(arg)
    const inline = arg !== name
    if (MANAGER_VALUE.has(name)) {
      const value = inline ? arg.slice(name.length + 1) : takesNext(argv, i) ? argv[++i] : undefined
      if (name === '--webui-port' && value !== undefined && /^\d+$/.test(value) && +value > 0 && +value <= 65535) {
        result.webuiPort = +value
      }
      continue
    }
    if (SHARED_FLAG.has(name)) {
      result.shared.push(arg)
      continue
    }
    if (SHARED_VALUE.has(name)) {
      result.shared.push(arg)
      if (!inline && takesNext(argv, i)) result.shared.push(argv[++i])
      continue
    }
    // Not the bot's: the target's, with the value that follows it (`-q 123`, `--plugin <name>`)
    result.target.push(arg)
    if (!inline && takesNext(argv, i)) result.target.push(argv[++i])
  }
  return result
}

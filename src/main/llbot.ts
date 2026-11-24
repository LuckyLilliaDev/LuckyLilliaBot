/**
 * llbot.js: what every launcher runs. A small supervisor that runs the instance manager (llbot-manager.js) as a
 * child, which runs every instance (llbot-core.js) and serves their WebUIs on one address. The supervisor starts
 * the manager again when it asks, e.g. after an update replaced its files. In a container it starts the release the
 * bot installed into the data volume when that one is newer (see runtime.ts).
 *
 * `--no-manager` runs one instance (llbot-core.js) under this supervisor as before the manager, with its own WebUI;
 * `--no-supervisor` runs that instance in this process, which then cannot restart itself. A release without the
 * manager, installed into a data volume by an older version, also runs its instance directly.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chooseCore, setRuntimeAside, type CoreChoice } from './runtime'
import { supervise } from './supervisor'

const args = process.argv.slice(2)
const choose = () => chooseCore({ installDir: import.meta.dirname })

/** The manager of the chosen release, if it has one and it is wanted */
function withManager(choice: CoreChoice): CoreChoice {
  if (args.includes('--no-manager')) return choice
  const manager = path.join(path.dirname(choice.core), 'llbot-manager.js')
  return existsSync(manager) ? { ...choice, core: manager } : choice
}

if (args.includes('--no-supervisor')) {
  const choice = choose()
  if (choice.note) console.log(`[supervisor] ${choice.note}`)
  await import(pathToFileURL(choice.core).href)
} else {
  supervise({ choose: () => withManager(choose()), onRuntimeFailed: () => setRuntimeAside(), args })
}

/**
 * llbot.js: what every launcher runs. A small supervisor that runs the bot (llbot-core.js) as a child, so the bot
 * can restart itself, e.g. after updating its own files. In a container it starts the release the bot installed
 * into the data volume when that one is newer (see runtime.ts). `--no-supervisor` runs the bot in this process
 * instead, as before; it then cannot restart itself.
 */
import { pathToFileURL } from 'node:url'
import { chooseCore, setRuntimeAside } from './runtime'
import { supervise } from './supervisor'

const args = process.argv.slice(2)
const choose = () => chooseCore({ installDir: import.meta.dirname })

if (args.includes('--no-supervisor')) {
  const choice = choose()
  if (choice.note) console.log(`[supervisor] ${choice.note}`)
  await import(pathToFileURL(choice.core).href)
} else {
  supervise({ choose, onRuntimeFailed: () => setRuntimeAside(), args })
}

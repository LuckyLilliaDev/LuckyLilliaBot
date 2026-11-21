/**
 * llbot.js: what every launcher runs. A small supervisor that runs the bot (llbot-core.js) as a child, so the bot
 * can restart itself, e.g. after updating its own files. `--no-supervisor` runs the bot in this process instead,
 * as before; it then cannot restart itself.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { supervise } from './supervisor'

const core = path.join(import.meta.dirname, 'llbot-core.js')
const args = process.argv.slice(2)

if (args.includes('--no-supervisor')) {
  await import(pathToFileURL(core).href)
} else {
  supervise({ core, args })
}

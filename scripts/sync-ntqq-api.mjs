/** Refresh the NTQQ OneBot action and internal method manifests from a built NTQQ plugin package. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.resolve(process.argv[2] || path.join(root, '../LuckyLillia.Plugins/lucky-lillia-plugin-ntqq-protocol'))
const output = path.join(root, 'src/ntqq')
const pkg = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'))
if (pkg.name !== '@luckylillia-dev/plugin-nt-protocol') throw new Error('Expected the NTQQ plugin package')

const actionNames = JSON.parse(await fs.readFile(path.join(plugin, 'lib/onebot-actions.json'), 'utf8'))
if (!Array.isArray(actionNames) || !actionNames.length || actionNames.some(name => typeof name !== 'string' || !name)) {
  throw new Error('Invalid NTQQ OneBot action name manifest')
}
const internalMethods = JSON.parse(await fs.readFile(path.join(plugin, 'lib/onebot-internal.json'), 'utf8'))
if (!internalMethods || Array.isArray(internalMethods) || typeof internalMethods !== 'object'
  || !Object.keys(internalMethods).length
  || Object.entries(internalMethods).some(([method, action]) => !method || !actionNames.includes(action))) {
  throw new Error('Invalid NTQQ bot.internal method manifest')
}

await fs.mkdir(output, { recursive: true })
await fs.writeFile(path.join(output, 'onebot-actions.json'), JSON.stringify([...new Set(actionNames)].sort(), null, 2) + '\n')
await fs.writeFile(path.join(output, 'onebot-internal.json'), JSON.stringify(internalMethods, null, 2) + '\n')
await fs.writeFile(path.join(output, 'source.json'), JSON.stringify({
  package: pkg.name,
  version: pkg.version,
  note: 'Action and internal method manifests for SDK type generation. Protocol implementation is supplied by the installed plugin.',
}, null, 2) + '\n')
console.log(`Synced ${actionNames.length} action names and ${Object.keys(internalMethods).length} internal methods`)

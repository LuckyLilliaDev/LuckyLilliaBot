// End-to-end check of the self-update (src/main/coreUpdate.ts) through the supervisor (src/main/supervisor.ts):
// a built dist updates itself to a copy reporting the next patch version, served by a local fake registry.
// Everything lives in a temp directory with its own test instance and token. Run after npm run build:
//   node test/manual/core-update.mjs
import { spawn, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const bot = path.resolve(import.meta.dirname, '../..')
const work = mkdtempSync(path.join(tmpdir(), 'llbot-e2e-update-'))
const installed = path.join(work, 'install')
const release = path.join(work, 'release', 'package')
const PACKAGE = '@luckylillia-dev/luckylillia'
const TOKEN = 'e2e-test-token-' + Math.random().toString(36).slice(2)
const PORT = 3987
const log = (...args) => console.log('[e2e]', ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The installed 9.0.0, with some user data and a file the package does not carry
cpSync(path.join(bot, 'dist'), installed, { recursive: true })
rmSync(path.join(installed, 'data'), { recursive: true, force: true })
writeFileSync(path.join(installed, 'node.exe.marker'), 'not in the package')

// The 9.0.1 release: the same build, reporting 9.0.1, under the new package name
cpSync(path.join(bot, 'dist'), release, { recursive: true })
rmSync(path.join(release, 'data'), { recursive: true, force: true })
const core = path.join(release, 'llbot-core.js')
writeFileSync(core, readFileSync(core, 'utf8').replaceAll('"9.0.0"', '"9.0.1"'))
const manifest = JSON.parse(readFileSync(path.join(release, 'package.json'), 'utf8'))
writeFileSync(path.join(release, 'package.json'), JSON.stringify({ ...manifest, name: PACKAGE, version: '9.0.1' }))
writeFileSync(path.join(release, 'release-marker.txt'), '9.0.1')
const tgz = path.join(work, 'release.tgz')
execSync(`tar --force-local -czf "${tgz.replaceAll('\\', '/')}" -C "${path.dirname(release).replaceAll('\\', '/')}" package`)
const tarball = readFileSync(tgz)
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')
log('release tarball', Math.round(tarball.length / 1024 / 1024) + ' MB')

// The fake registry
const registry = createServer((req, res) => {
  if (decodeURIComponent(req.url) === `/${PACKAGE}`) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({
      name: PACKAGE, 'dist-tags': { latest: '9.0.1' },
      versions: { '9.0.1': { name: PACKAGE, version: '9.0.1', engines: { node: '>=22.15' }, dist: { tarball: `http://127.0.0.1:${registry.address().port}/release.tgz`, integrity } } },
    }))
  }
  if (req.url === '/release.tgz') return res.end(tarball)
  res.statusCode = 404
  res.end('{}')
})
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))
const registryUrl = `http://127.0.0.1:${registry.address().port}`

// The test instance: market pointed at the fake registry, WebUI on a fixed port with a known token
const instance = path.join(installed, 'data', 'instances', 'default')
mkdirSync(instance, { recursive: true })
writeFileSync(path.join(instance, 'webui_token.txt'), TOKEN)
writeFileSync(path.join(instance, 'settings.json'), JSON.stringify({ webui: { enable: true, host: '127.0.0.1', port: PORT } }))
writeFileSync(path.join(instance, 'plugins.json'), JSON.stringify({ version: 1, entries: [
  { id: 'a0000001', name: 'builtin:market', config: { registry: registryUrl, mirrors: [] } },
] }))
writeFileSync(path.join(installed, 'data', 'user-file.txt'), 'keep me')

const out = openSync(path.join(work, 'bot.log'), 'a')
const supervisor = spawn(process.execPath, ['--enable-source-maps', 'llbot.js'], { cwd: installed, stdio: ['ignore', out, out], windowsHide: true })
log('supervisor pid', supervisor.pid)
let supervisorExit
supervisor.on('exit', code => { supervisorExit = code })

const api = async (route, method = 'GET', body) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/core-update${route}`, {
    method, headers: { 'X-Webui-Token': createHash('sha256').update(TOKEN).digest('hex'), 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return response.json()
}
let last
const waitFor = async (what, test, timeout = 90_000) => {
  const start = Date.now()
  for (;;) {
    try {
      const value = await test()
      if (value) return value
    } catch (error) { last = error.message }
    if (supervisorExit !== undefined) throw new Error(`supervisor exited (${supervisorExit}) while waiting for ${what}`)
    if (Date.now() - start > timeout) throw new Error('timed out waiting for ' + what + '; last: ' + last)
    await sleep(1000)
  }
}

let failed = false
const expect = (label, ok) => { log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed = true }
try {
  const before = await waitFor('the WebUI', async () => { const body = await api('/status'); last = JSON.stringify(body); return body.data })
  expect('runs 9.0.0 at first', before.current === '9.0.0')
  expect('not blocked under the supervisor', !before.blocked)
  const checked = (await api('/check', 'POST')).data
  log('check', JSON.stringify(checked))
  expect('finds 9.0.1 available', checked.latest === '9.0.1' && checked.available)
  const started = (await api('/update', 'POST', { version: '9.0.1' }))
  log('update', JSON.stringify(started))
  expect('update accepted and restarting', started.success && started.data.state === 'restarting')
  const after = await waitFor('9.0.1 to answer', async () => {
    const status = (await api('/status')).data
    return status?.current === '9.0.1' && status
  })
  expect('runs 9.0.1 after the restart', after.current === '9.0.1')
  expect('the same supervisor is still running', supervisorExit === undefined)
  expect('package files replaced', readFileSync(path.join(installed, 'release-marker.txt'), 'utf8') === '9.0.1'
    && JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version === '9.0.1')
  expect('data kept', readFileSync(path.join(installed, 'data', 'user-file.txt'), 'utf8') === 'keep me'
    && existsSync(path.join(instance, 'webui_token.txt')))
  expect('file outside the package kept', existsSync(path.join(installed, 'node.exe.marker')))
  expect('old version backed up', existsSync(path.join(installed, '.llbot-update', 'backup-9.0.0', 'llbot-core.js')))
  const restarted = readFileSync(path.join(work, 'bot.log'), 'utf8').includes('[supervisor] restarting the bot')
  expect('the supervisor logged the restart', restarted)
} catch (error) {
  failed = true
  log('ERROR', error.message)
} finally {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${supervisor.pid} /T /F`, { stdio: 'ignore' }) } catch {}
  } else supervisor.kill('SIGTERM')
  registry.close()
  await sleep(1500)
  if (failed) log('log kept at', path.join(work, 'bot.log'))
  else rmSync(work, { recursive: true, force: true })
  log(failed ? 'E2E FAILED' : 'E2E PASSED')
  process.exit(failed ? 1 : 0)
}

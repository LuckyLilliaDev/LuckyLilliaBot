// End-to-end check of the container self-update (src/main/runtime.ts): LLBOT_CONTAINER=1 makes a built dist act as
// an image whose data/ is the data volume. Run after npm run build:
//   node test/manual/core-update-container.mjs
// 1. update: the release lands in data/llbot-runtime, the image files stay
// 2. recreate the container (same image, same volume): the installed release starts again
// 3. a newer image: it wins and the leftover in the volume is removed
// 4. a release in the volume that cannot start: set aside after three tries, the image version starts
import { execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const bot = path.resolve(import.meta.dirname, '../..')
const work = mkdtempSync(path.join(tmpdir(), 'llbot-e2e-container-'))
const image = path.join(work, 'image')
const volume = path.join(image, 'data')
const runtime = path.join(volume, 'llbot-runtime')
const PACKAGE = '@luckylillia-dev/luckylillia'
const TOKEN = 'e2e-test-token-' + Math.random().toString(36).slice(2)
const PORT = 3988
const log = (...args) => console.log('[e2e]', ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const posix = file => file.replaceAll('\\', '/')

/** A copy of the built dist that reports `version` */
function makeRelease(dir, version, name = PACKAGE) {
  cpSync(path.join(bot, 'dist'), dir, { recursive: true })
  rmSync(path.join(dir, 'data'), { recursive: true, force: true })
  const core = path.join(dir, 'llbot-core.js')
  writeFileSync(core, readFileSync(core, 'utf8').replaceAll('"9.0.0"', `"${version}"`))
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, name, version }))
}

makeRelease(image, '9.0.0', 'llonebot-dist')
const releaseDir = path.join(work, 'release', 'package')
makeRelease(releaseDir, '9.0.1')
const tgz = path.join(work, 'release.tgz')
execSync(`tar --force-local -czf "${posix(tgz)}" -C "${posix(path.dirname(releaseDir))}" package`)
const tarball = readFileSync(tgz)
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')

const registry = createServer((req, res) => {
  if (decodeURIComponent(req.url) === `/${PACKAGE}`) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ name: PACKAGE, 'dist-tags': { latest: '9.0.1' }, versions: { '9.0.1': {
      name: PACKAGE, version: '9.0.1', engines: { node: '>=22.15' },
      dist: { tarball: `http://127.0.0.1:${registry.address().port}/release.tgz`, integrity },
    } } }))
  }
  if (req.url === '/release.tgz') return res.end(tarball)
  res.statusCode = 404
  res.end('{}')
})
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))

const instance = path.join(volume, 'instances', 'default')
mkdirSync(instance, { recursive: true })
writeFileSync(path.join(volume, 'webui_token.txt'), TOKEN)
writeFileSync(path.join(instance, 'settings.json'), JSON.stringify({ webui: { enable: true, host: '127.0.0.1', port: PORT } }))
writeFileSync(path.join(instance, 'plugins.json'), JSON.stringify({ version: 1, entries: [
  { id: 'a0000001', name: 'builtin:market', config: { registry: `http://127.0.0.1:${registry.address().port}`, mirrors: [] } },
] }))

const logFile = path.join(work, 'bot.log')
let supervisor
let supervisorExit
function startContainer(label) {
  writeFileSync(logFile, `\n===== ${label}\n`, { flag: 'a' })
  const out = openSync(logFile, 'a')
  supervisorExit = undefined
  supervisor = spawn(process.execPath, ['llbot.js'], { cwd: image, env: { ...process.env, LLBOT_CONTAINER: '1' }, stdio: ['ignore', out, out], windowsHide: true })
  supervisor.on('exit', code => { supervisorExit = code })
}
async function stopContainer() {
  if (supervisorExit !== undefined) return
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${supervisor.pid} /T /F`, { stdio: 'ignore' }) } catch {}
  } else supervisor.kill('SIGTERM')
  for (let i = 0; i < 50 && supervisorExit === undefined; i++) await sleep(200)
  // The instance lock and the port need a moment once the bot is gone
  await sleep(1500)
}
const api = async (route, method = 'GET', body) => (await fetch(`http://127.0.0.1:${PORT}/api/core-update${route}`, {
  method, headers: { 'X-Webui-Token': createHash('sha256').update(TOKEN).digest('hex'), 'content-type': 'application/json' },
  body: body && JSON.stringify(body),
})).json()
async function runningVersion(expected, timeout = 120_000) {
  const start = Date.now()
  let last
  for (;;) {
    try {
      last = (await api('/status')).data?.current
      if (last === expected) return last
    } catch {}
    if (supervisorExit !== undefined) throw new Error(`supervisor exited (${supervisorExit}) waiting for ${expected}`)
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${expected}, last ${last}`)
    await sleep(1000)
  }
}

let failed = false
const expect = (label, ok) => { log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed = true }
const version = dir => { try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version } catch { return undefined } }
try {
  log('1. update inside the container')
  startContainer('image 9.0.0')
  await runningVersion('9.0.0')
  const checked = (await api('/check', 'POST')).data
  expect('a container may update itself', checked.available && !checked.blocked)
  const started = await api('/update', 'POST', { version: '9.0.1' })
  expect('update accepted', started.success && started.data.state === 'restarting')
  await runningVersion('9.0.1')
  expect('the release is in the data volume', version(runtime) === '9.0.1')
  expect('the image files are untouched', version(image) === '9.0.0' && !existsSync(path.join(image, '.llbot-update')))
  expect('no staging left in the volume', !existsSync(`${runtime}.staging-9.0.1`) && !existsSync(`${runtime}.old`))
  expect('the same supervisor restarted it', supervisorExit === undefined)
  await stopContainer()

  log('2. recreate the container from the same image')
  startContainer('recreated, same image')
  await runningVersion('9.0.1')
  expect('the installed release starts again', true)
  await stopContainer()

  log('3. a newer image')
  const core = path.join(image, 'llbot-core.js')
  writeFileSync(core, readFileSync(core, 'utf8').replaceAll('"9.0.0"', '"9.0.2"'))
  const manifest = JSON.parse(readFileSync(path.join(image, 'package.json'), 'utf8'))
  writeFileSync(path.join(image, 'package.json'), JSON.stringify({ ...manifest, version: '9.0.2' }))
  startContainer('newer image 9.0.2')
  await runningVersion('9.0.2')
  expect('the newer image wins', true)
  expect('the superseded release is removed from the volume', !existsSync(runtime))
  await stopContainer()

  log('4. a release in the volume that cannot start')
  makeRelease(runtime, '9.0.3')
  writeFileSync(path.join(runtime, 'llbot-core.js'), "throw new Error('broken release')\n")
  startContainer('broken 9.0.3 in the volume')
  await runningVersion('9.0.2')
  expect('falls back to the image version', true)
  expect('the broken release is set aside', !existsSync(runtime) && version(`${runtime}.failed`) === '9.0.3')
  const output = readFileSync(logFile, 'utf8')
  expect('the log says why', output.includes('连续 3 次启动失败'))
  await stopContainer()
} catch (error) {
  failed = true
  log('ERROR', error.message)
} finally {
  await stopContainer()
  registry.close()
  if (failed) log('log kept at', logFile)
  else rmSync(work, { recursive: true, force: true })
  log(failed ? 'E2E FAILED' : 'E2E PASSED')
  process.exit(failed ? 1 : 0)
}

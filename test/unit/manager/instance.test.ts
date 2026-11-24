import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { InstanceProcess, type InstanceStatus } from '@/main/manager/instance'

const work = mkdtempSync(path.join(os.tmpdir(), 'llbot-instance-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** A stand-in llbot-core.js: reports a WebUI port, shuts down when asked, then does what MODE says */
const core = path.join(work, 'core.mjs')
writeFileSync(core, `
  import http from 'node:http'
  import { existsSync, readFileSync, writeFileSync } from 'node:fs'
  const runs = (existsSync(process.env.RUNS) ? Number(readFileSync(process.env.RUNS, 'utf8')) : 0) + 1
  writeFileSync(process.env.RUNS, String(runs))
  console.log('run ' + runs + ' args=' + JSON.stringify(process.argv.slice(2)))
  console.log('env ' + [process.env.LLBOT_MANAGED, process.env.LLBOT_SUPERVISED, process.env.LLBOT_WEBUI_HOST, process.env.LLBOT_WEBUI_PORT, process.env.LLBOT_INSTANCE ?? '-'].join(','))
  const mode = process.env.MODE
  if (mode === 'crash') process.exit(3)
  if (mode === 'restart-once' && runs === 1) setTimeout(() => process.exit(75), 50)
  const server = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', () => {
    process.send({ type: 'webui', port: server.address().port })
  })
  process.on('message', (message) => {
    if (message.type !== 'shutdown' || mode === 'hang') return
    console.error('shutting down')
    server.close()
    process.exit(0)
  })
`)

const running: InstanceProcess[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map(instance => instance.stop(1000)))
})

function create(mode: string, options: { maxRestarts?: number; stopTimeout?: number } = {}) {
  const lines: string[] = []
  const changes: InstanceStatus[] = []
  const instance = new InstanceProcess('bot2', {
    core,
    execArgv: [],
    args: () => ['--cdn', 'china'],
    env: { ...process.env, MODE: mode, RUNS: path.join(work, `runs-${Math.random().toString(36).slice(2)}`), LLBOT_INSTANCE: 'other' },
    secret: 's',
    output: (name, line, stream) => lines.push(`${name}:${stream}:${line}`),
    onChange: status => changes.push(status),
    ...options,
  })
  running.push(instance)
  return { instance, lines, changes }
}

const until = async (test: () => boolean, timeout = 5000) => {
  const start = Date.now()
  while (!test()) {
    if (Date.now() - start > timeout) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('an instance under the manager', () => {
  it('starts with its name and the manager as parent, and is running once its WebUI is up', async () => {
    const { instance, lines } = create('normal')
    instance.start()
    expect(instance.status().phase).toBe('starting')
    await until(() => instance.status().phase === 'running')
    expect(instance.status().webuiPort).toBeGreaterThan(0)
    await until(() => lines.length >= 2)
    expect(lines[0]).toBe(`bot2:stdout:run 1 args=${JSON.stringify(['--cdn', 'china', '--instance', 'bot2', `--parent-pid=${process.pid}`])}`)
    // Managed and supervised, its WebUI on 127.0.0.1 with any port, and not the manager's instance name
    expect(lines[1]).toBe('bot2:stdout:env 1,1,127.0.0.1,0,-')
  })

  it('shuts down cleanly when asked', async () => {
    const { instance, lines } = create('normal')
    instance.start()
    await until(() => instance.status().phase === 'running')
    await instance.stop()
    expect(instance.status()).toMatchObject({ phase: 'stopped', exitCode: 0 })
    expect(lines).toContain('bot2:stderr:shutting down')
  })

  it('starts again when it asks for a restart', async () => {
    const { instance, lines } = create('restart-once')
    instance.start()
    await until(() => lines.some(line => line.includes('run 2')))
    await until(() => instance.status().phase === 'running')
  })

  it('is marked failed when it keeps crashing', async () => {
    const { instance } = create('crash', { maxRestarts: 0 })
    instance.start()
    await until(() => instance.status().phase === 'failed')
    expect(instance.status()).toMatchObject({ exitCode: 3, error: expect.stringContaining('已停止自动重启') })
    expect(instance.recentOutput().some(line => line.startsWith('run 1'))).toBe(true)
  })

  it('is killed when it does not stop in time', async () => {
    const { instance } = create('hang', { stopTimeout: 300 })
    instance.start()
    await until(() => instance.status().phase === 'running')
    const started = Date.now()
    await instance.stop()
    expect(instance.status().phase).toBe('stopped')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parentPidOf, RESTART_EXIT_CODE, withoutParentPid } from '@/main/restart'

const repository = path.resolve(import.meta.dirname, '../../..')
const work = mkdtempSync(path.join(tmpdir(), 'llbot-supervisor-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** Runs supervise() in a real process around a stand-in bot, and resolves to what came out of it. */
function run(core: string, args: string[], options: { maxRestarts?: number; onStart?: (pid: number) => void } = {}) {
  const harness = path.join(work, `harness-${Math.random().toString(36).slice(2)}.mts`)
  writeFileSync(harness, `
    import { supervise } from ${JSON.stringify(pathToFileURL(path.join(repository, 'src/main/supervisor.ts')).href)}
    supervise({ core: process.env.CORE, args: process.argv.slice(2), execArgv: [], maxRestarts: ${options.maxRestarts ?? 5}, log: m => console.log('[supervisor] ' + m) })
  `)
  return new Promise<{ code: number | null; output: string; pid: number }>((resolve) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), harness, ...args], {
      env: { ...process.env, CORE: core, RUNS: path.join(work, `runs-${Math.random().toString(36).slice(2)}`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
      if (String(data).includes('ready')) options.onStart?.(child.pid!)
    })
    child.stderr.on('data', data => output += data)
    child.on('exit', code => resolve({ code, output, pid: child.pid! }))
  })
}

/** A stand-in bot: counts its runs in $RUNS and does what its run number says. */
function bot(name: string, body: string): string {
  const file = path.join(work, name)
  writeFileSync(file, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs'
    const runs = (existsSync(process.env.RUNS) ? Number(readFileSync(process.env.RUNS, 'utf8')) : 0) + 1
    writeFileSync(process.env.RUNS, String(runs))
    const args = process.argv.slice(2)
    console.log('run ' + runs + ' args=' + JSON.stringify(args) + ' ppid=' + process.ppid + ' supervised=' + process.env.LLBOT_SUPERVISED)
    ${body}
  `)
  return file
}

describe('the supervisor', () => {
  it('starts the bot again when it asks for a restart, then exits with its exit code', async () => {
    const core = bot('restart-once.mjs', `process.exit(runs === 1 ? ${RESTART_EXIT_CODE} : 3)`)
    const result = await run(core, ['--instance', 'a', '--parent-pid=999999999', '-q', '123'])
    expect(result.code).toBe(3)
    const lines = result.output.split(/\r?\n/).filter(line => line.startsWith('run '))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      // The bot watches the supervisor, not the launcher, and keeps every other argument
      expect(line).toContain(`args=${JSON.stringify(['--instance', 'a', '-q', '123', `--parent-pid=${result.pid}`])}`)
      expect(line).toContain(`ppid=${result.pid}`)
      expect(line).toContain('supervised=1')
    }
    expect(result.output).toContain('[supervisor] restarting the bot')
  }, 30_000)

  it('gives up on a bot that keeps asking for restarts', async () => {
    const core = bot('restart-always.mjs', `process.exit(${RESTART_EXIT_CODE})`)
    const result = await run(core, [], { maxRestarts: 2 })
    expect(result.code).toBe(1)
    expect(result.output.split(/\r?\n/).filter(line => line.startsWith('run '))).toHaveLength(3)
    expect(result.output).toContain('giving up')
  }, 30_000)

  it('exits when the process given as --parent-pid is gone, leaving the bot to stop on its own', async () => {
    const core = bot('lingering.mjs', `console.log('ready'); setTimeout(() => {}, 20_000)`)
    // A pid that is not running: the supervisor notices within a second
    const result = await run(core, ['--parent-pid=999999999'])
    expect(result.code).toBe(0)
  }, 30_000)

  it.skipIf(process.platform === 'win32')('passes SIGTERM on to the bot once and exits with its code', async () => {
    const core = bot('graceful.mjs', `
      let signals = 0
      process.on('SIGTERM', () => { signals++; console.log('stopping after ' + signals + ' signal'); setTimeout(() => process.exit(0), 200) })
      console.log('ready')
      setTimeout(() => {}, 20_000)
    `)
    const result = await run(core, [], { onStart: pid => process.kill(pid, 'SIGTERM') })
    expect(result.code).toBe(0)
    expect(result.output).toContain('stopping after 1 signal')
    expect(result.output).not.toContain('restarting')
  }, 30_000)
})

describe('--parent-pid handling', () => {
  it('reads the first one in either form and strips them all', () => {
    expect(parentPidOf(['--a', '--parent-pid=12', '--parent-pid', '13'])).toBe(12)
    expect(parentPidOf(['--parent-pid', '13'])).toBe(13)
    expect(parentPidOf(['--parent-pid=abc'])).toBeNaN()
    expect(parentPidOf(['--parent-pid=0'])).toBeNaN()
    expect(withoutParentPid(['-q', '1', '--parent-pid=12', '--parent-pid', '13', '--x'])).toEqual(['-q', '1', '--x'])
  })
})

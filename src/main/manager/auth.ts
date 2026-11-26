import { createHash, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const hashPassword = (password: string): string => createHash('sha256').update(password).digest('hex')

/** How the login refused a request; `reason` goes out in the X-Webui-Auth header the WebUI asks for the password on */
export interface LoginRefusal {
  status: 401 | 403
  reason: 'unset' | 'required' | 'wrong' | 'locked'
  body: Record<string, unknown>
}

const FAILURES_BEFORE_LOCK = 4
const LOCK_TIME = 60 * 60 * 1000

export interface GatewayAuthOptions {
  /** data/webui_token.txt: the one WebUI password of all instances */
  file: string
  /** data/logs/webui_access.log */
  accessLog?: string
  log?: { info(message: string): void; warn(message: string): void }
  now?: () => number
}

/**
 * The WebUI login of all instances, checked once in the gateway. Same protocol as an instance's own login had
 * (BE/auth.ts): the browser presents sha256(password); refusals carry X-Webui-Auth; four wrong passwords in a row
 * lock it for an hour, whatever the address.
 */
export class GatewayAuth {
  private token = ''
  private mtimeMs = -1
  private failures = 0
  private lockedUntil = 0

  constructor(private readonly options: GatewayAuthOptions) {}

  /** The password; re-read when the file changed (the desktop app or a hand edit may reset it) */
  getToken(): string {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.options.file).mtimeMs
    } catch {
      // A file that went missing keeps the last password rather than opening the WebUI to everyone
      return this.token
    }
    if (mtimeMs !== this.mtimeMs) {
      this.token = readFileSync(this.options.file, 'utf8').trim()
      this.mtimeMs = mtimeMs
    }
    return this.token
  }

  setToken(token: string): void {
    mkdirSync(path.dirname(this.options.file), { recursive: true })
    writeFileSync(this.options.file, token.trim(), 'utf8')
    this.token = token.trim()
    this.mtimeMs = statSync(this.options.file).mtimeMs
  }

  /** Whether `presented` is the password, without counting a wrong one: for requests that only pass it along */
  matches(presented: string | undefined): boolean {
    const token = this.getToken()
    return !!token && !!presented && safeEqual(presented, hashPassword(token))
  }

  /** Checks a request's password, a wrong one counting towards the lock; undefined when it may pass */
  check(presented: string | undefined, ip: string, method: string, url: string): LoginRefusal | undefined {
    const token = this.getToken()
    if (!token) {
      this.access(ip, method, url, 401, '未设置密码')
      return { status: 401, reason: 'unset', body: { success: false, message: '请先设置WebUI密码' } }
    }
    const now = this.options.now?.() ?? Date.now()
    if (this.lockedUntil) {
      if (now < this.lockedUntil) {
        const remainingMinutes = Math.ceil((this.lockedUntil - now) / 60_000)
        this.access(ip, method, url, 403, `账户锁定中，剩余${remainingMinutes}分钟`)
        return {
          status: 403,
          reason: 'locked',
          body: { success: false, message: `密码错误次数过多，请在 ${remainingMinutes} 分钟后重试`, locked: true, remainingMinutes },
        }
      }
      this.failures = 0
      this.lockedUntil = 0
    }
    if (!presented) return { status: 403, reason: 'required', body: { success: false, message: '请输入密码' } }
    if (!safeEqual(presented, hashPassword(token))) {
      this.failures++
      if (this.failures >= FAILURES_BEFORE_LOCK) {
        this.lockedUntil = now + LOCK_TIME
        this.access(ip, method, url, 403, `密码连续错误${FAILURES_BEFORE_LOCK}次，账户锁定1小时`)
        return {
          status: 403,
          reason: 'locked',
          body: { success: false, message: `密码连续错误${FAILURES_BEFORE_LOCK}次，账户已被锁定1小时`, locked: true, remainingMinutes: 60 },
        }
      }
      const remainingAttempts = FAILURES_BEFORE_LOCK - this.failures
      this.access(ip, method, url, 403, `Token验证失败，剩余${remainingAttempts}次尝试`)
      return {
        status: 403,
        reason: 'wrong',
        body: { success: false, message: `Token校验失败，剩余尝试次数：${remainingAttempts}`, remainingAttempts },
      }
    }
    if (this.failures > 0) {
      this.access(ip, method, url, 200, '登录成功，重置失败计数')
      this.failures = 0
      this.lockedUntil = 0
    }
    this.access(ip, method, url, 200)
    return undefined
  }

  private access(ip: string, method: string, url: string, status: number, message?: string) {
    if (!this.options.accessLog) return
    try {
      appendFileSync(this.options.accessLog,
        `${new Date().toISOString()} | IP: ${ip} | ${method} ${url} | Status: ${status}${message ? ` | ${message}` : ''}\n`)
    } catch (error) {
      this.options.log?.warn(`写入访问日志失败：${(error as Error).message}`)
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

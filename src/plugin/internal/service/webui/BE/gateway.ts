import { timingSafeEqual } from 'node:crypto'
import {
  GATEWAY_AUTH_HEADER,
  GATEWAY_SECRET_ENV,
  GATEWAY_SECRET_HEADER,
  isManaged,
} from '@/main/manager/protocol'

/**
 * Under the instance manager the WebUI is reached through its gateway only: one address and one login for every
 * instance. This instance then listens on 127.0.0.1 and trusts the login check the gateway made.
 */
export const behindGateway = (env: NodeJS.ProcessEnv = process.env): boolean => isManaged(env) && !!env[GATEWAY_SECRET_ENV]

type Header = (name: string) => string | null | undefined

/** Whether the gateway sent this request: its secret is there. Anything else on this port is turned away. */
export function fromGateway(header: Header, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env[GATEWAY_SECRET_ENV]
  const presented = header(GATEWAY_SECRET_HEADER)
  if (!secret || !presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Whether the gateway checked this request's WebUI login */
export function gatewayAuthenticated(header: Header, env: NodeJS.ProcessEnv = process.env): boolean {
  return fromGateway(header, env) && header(GATEWAY_AUTH_HEADER) === 'ok'
}

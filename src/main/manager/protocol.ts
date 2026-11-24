/**
 * What the instance manager (llbot-manager.js) and the instances it runs (llbot-core.js) agree on. No imports: the
 * core reads this before anything else of the bot is loaded.
 */

/** Set in an instance's environment when the manager runs it */
export const MANAGED_ENV = 'LLBOT_MANAGED'

/**
 * The secret the gateway sends with every request it forwards. An instance under the manager listens on 127.0.0.1
 * only, but any local process could reach that port: without this header it answers nothing.
 */
export const GATEWAY_SECRET_ENV = 'LLBOT_GATEWAY_SECRET'
export const GATEWAY_SECRET_HEADER = 'x-llbot-gateway'

/** Set by the gateway on a forwarded request it has checked the WebUI login of */
export const GATEWAY_AUTH_HEADER = 'x-llbot-auth'

/** The instance a request was routed to, and the path prefix the gateway removed (`/i/<name>`) */
export const GATEWAY_INSTANCE_HEADER = 'x-llbot-instance'
export const GATEWAY_PREFIX_HEADER = 'x-forwarded-prefix'

export type PackageRpcAction = 'prepare' | 'finish'

/** Instance → manager */
export type InstanceMessage =
  /** The instance's WebUI listens on 127.0.0.1:port; it is ready to be routed to */
  | { type: 'webui'; port: number }
  /** Registers this instance's SharedPackages peer and canonical roots with the manager */
  | { type: 'pkg:register'; id: string; roots: string[] }
  /** Unregisters this instance's SharedPackages peer on shutdown */
  | { type: 'pkg:unregister'; id: string }
  /** Asks the manager to broadcast a prepare/finish RPC to every other managed peer sharing `root` */
  | { type: 'pkg:broadcast'; reqId: string; senderId: string; root: string; action: PackageRpcAction; change: Record<string, unknown>; applied?: boolean }
  /** Reply to a manager-initiated `pkg:rpc` */
  | { type: 'pkg:rpc-result'; reqId: string; value?: unknown; error?: string }

/** Manager → instance */
export type ManagerMessage =
  /** Shut down cleanly, as for Ctrl+C */
  | { type: 'shutdown' }
  /** Forwarded shared-package prepare/finish request from another managed instance */
  | { type: 'pkg:rpc'; reqId: string; action: PackageRpcAction; change: Record<string, unknown>; applied?: boolean }
  /** Aggregated reply to `pkg:broadcast` */
  | { type: 'pkg:broadcast-result'; reqId: string; results?: unknown[]; error?: string }

export const isManaged = (env: NodeJS.ProcessEnv = process.env): boolean => env[MANAGED_ENV] === '1'

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

export function isInstanceMessage(value: unknown): value is InstanceMessage {
  if (!isObject(value)) return false
  switch (value.type) {
    case 'webui':
      return Number.isInteger(value.port)
    case 'pkg:register':
      return typeof value.id === 'string' && Array.isArray(value.roots) && value.roots.every(r => typeof r === 'string')
    case 'pkg:unregister':
      return typeof value.id === 'string'
    case 'pkg:broadcast':
      return typeof value.reqId === 'string' && typeof value.senderId === 'string' && typeof value.root === 'string'
        && (value.action === 'prepare' || value.action === 'finish') && isObject(value.change)
    case 'pkg:rpc-result':
      return typeof value.reqId === 'string'
    default:
      return false
  }
}

export function isManagerMessage(value: unknown): value is ManagerMessage {
  if (!isObject(value)) return false
  switch (value.type) {
    case 'shutdown':
      return true
    case 'pkg:rpc':
      return typeof value.reqId === 'string' && (value.action === 'prepare' || value.action === 'finish') && isObject(value.change)
    case 'pkg:broadcast-result':
      return typeof value.reqId === 'string'
    default:
      return false
  }
}

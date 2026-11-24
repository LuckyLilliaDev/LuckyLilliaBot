import { existsSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '@/common/globalVars'
import { getInstanceArg, getSpecifiedUin } from '@/common/utils/environment'
import { DEFAULT_INSTANCE, INVALID_INSTANCE_NAME, isValidInstanceName } from '@/common/instanceName'

export { DEFAULT_INSTANCE, isValidInstanceName }

export function instancesDir(): string {
  return path.join(DATA_DIR, 'instances')
}

export interface InstanceChoice {
  name: string
  /** Why this one, for the startup log. */
  reason: string
}

/**
 * --instance, else LLBOT_INSTANCE, else the instance named after `-q <uin>` if there is one (what the migration
 * makes for an old account whose settings differed), else default. See config-storage §4.
 */
export function resolveInstance(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env, dir = instancesDir()): InstanceChoice {
  const fromArgv = getInstanceArg(argv, {})
  const requested = fromArgv ?? getInstanceArg([], env)
  if (requested !== undefined) {
    if (!isValidInstanceName(requested)) {
      throw new Error(`实例名 "${requested}" 不合法：${INVALID_INSTANCE_NAME}`)
    }
    return { name: requested, reason: fromArgv !== undefined ? '--instance' : 'LLBOT_INSTANCE' }
  }
  const uin = getSpecifiedUin(argv)
  if (uin && isValidInstanceName(uin) && existsSync(path.join(dir, uin))) {
    return { name: uin, reason: `-q ${uin}，且有同名实例` }
  }
  return { name: DEFAULT_INSTANCE, reason: '默认实例' }
}

let current: InstanceChoice | undefined

/**
 * The instance this process runs, fixed on first use. main.ts makes that first use after the startup migration,
 * which may create the instance `-q` points to.
 */
export function currentInstance(): InstanceChoice {
  return current ??= resolveInstance()
}

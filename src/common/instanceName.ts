/** The default instance: always there, made by the first start */
export const DEFAULT_INSTANCE = 'default'

// Also a directory name and part of a lock name: nothing Windows or a pipe name would trip over
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidInstanceName(name: string): boolean {
  return INSTANCE_NAME.test(name)
}

export const INVALID_INSTANCE_NAME = '实例名只能用字母、数字、_ 和 -，以字母或数字开头，最长 64 个字符'

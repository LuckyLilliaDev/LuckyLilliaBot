import JSON5 from 'json5'
import { isPlainObject } from './diff'
import { classifyUnion, localize, mergeIntersect, type SchemaNode } from './model'

export type ConfigPatch =
  | { kind: 'set'; path: string[]; raw: string }
  | { kind: 'merge'; value: Record<string, unknown> }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** `name[key=value]`: the first item of the list `name` whose `key` is `value` (added when there is none) */
const SELECTOR = /^([^[\]=]+)\[([^[\]=]+)=([^[\]]*)\]$/

export class ConfigPatchError extends Error {}

export function parseJsonLike(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    try {
      return JSON5.parse(raw)
    } catch (error) {
      throw new ConfigPatchError(`${context} 不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function assertSafeObject(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeObject(item, context)
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ConfigPatchError(`${context} 包含非法键名「${key}」`)
    assertSafeObject(value[key], context)
  }
}

function unwrap(node: SchemaNode | null): SchemaNode | null {
  let current = node
  const seen = new Set<SchemaNode>()
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current.type === 'transform' && current.inner) {
      current = current.inner
      continue
    }
    if (current.type === 'union') {
      const view = classifyUnion(current)
      if (view.kind === 'single' || view.kind === 'optional') {
        current = view.inner
        continue
      }
    }
    break
  }
  return current
}

function objectDictOf(node: SchemaNode | null, current?: unknown): Record<string, SchemaNode> | undefined {
  const resolved = unwrap(node)
  if (!resolved) return undefined
  if (resolved.type === 'object') return resolved.dict
  if (resolved.type === 'intersect') return mergeIntersect(resolved)?.dict
  if (resolved.type === 'union') {
    const view = classifyUnion(resolved)
    if (view.kind === 'toggle') return objectDictOf(view.on, current)
    if (view.kind === 'tagged') {
      const tagNode: SchemaNode = {
        type: 'union',
        meta: {},
        list: view.branches.map(branch => ({
          type: 'const',
          value: branch.value,
          meta: { description: branch.label },
        })),
      }
      if (isPlainObject(current) && view.key in current) {
        const match = view.branches.find(branch => Object.is(branch.value, current[view.key]))
        if (match) {
          const matchedDict = objectDictOf(match.node, current)
          if (matchedDict) return { ...matchedDict, [view.key]: tagNode }
        }
      }
      const combined: Record<string, SchemaNode> = {}
      for (const branch of view.branches) {
        Object.assign(combined, objectDictOf(branch.node) ?? {})
      }
      if (Object.keys(combined).length) {
        combined[view.key] = tagNode
        return combined
      }
      return undefined
    }
  }
  return undefined
}

function isMergeableObjectNode(node: SchemaNode | null, value?: unknown): boolean {
  const resolved = unwrap(node)
  if (!resolved) return true
  if (resolved.type === 'dict') return true
  return objectDictOf(resolved, value) !== undefined
}

function formatAvailableFields(dict: Record<string, SchemaNode>): string {
  const entries = Object.entries(dict)
  const visible = entries.filter(([, child]) => !child.meta.hidden)
  const list = visible.length ? visible : entries
  return list.slice(0, 12).map(([key, child]) => {
    const desc = localize(child.meta.description)?.split(/[。；;\n]/, 1)[0]?.trim()
    return desc ? `${key}（${desc.length > 24 ? `${desc.slice(0, 24)}…` : desc}）` : key
  }).join('、') + (list.length > 12 ? ` 等 ${list.length} 项` : '')
}

function unknownFieldError(label: string | undefined, pathText: string, dict: Record<string, SchemaNode>): ConfigPatchError {
  const prefix = label ? `${label} ` : ''
  const available = formatAvailableFields(dict)
  return new ConfigPatchError(`${prefix}没有配置项「${pathText}」${available ? `，可用字段：${available}` : ''}`)
}

function parseBool(raw: string): boolean | undefined {
  const lowered = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true
  if (['false', '0', 'no', 'off'].includes(lowered)) return false
  return undefined
}

function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function coerceFallback(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = parseJsonLike(trimmed, '')
      assertSafeObject(parsed, '配置值')
      return parsed
    } catch {
      return raw
    }
  }
  return raw
}

export function coerceValue(raw: string, node: SchemaNode | null, pathText: string): unknown {
  if (!node) return coerceFallback(raw)
  if (node.type === 'transform' && node.inner) return coerceValue(raw, node.inner, pathText)

  if (node.type === 'string') return raw
  if (node.type === 'boolean') {
    const value = parseBool(raw)
    if (value === undefined) throw new ConfigPatchError(`配置项「${pathText}」需要布尔值（true / false），收到「${raw}」`)
    return value
  }
  if (node.type === 'number' || node.type === 'natural' || node.type === 'percent') {
    const value = parseNumber(raw)
    if (value === undefined) throw new ConfigPatchError(`配置项「${pathText}」需要数字，收到「${raw}」`)
    return value
  }
  if (node.type === 'const') {
    if (typeof node.value === 'string' && raw === node.value) return node.value
    if (typeof node.value === 'boolean' && parseBool(raw) === node.value) return node.value
    if (typeof node.value === 'number' && parseNumber(raw) === node.value) return node.value
    if (node.value === null && raw.trim() === 'null') return null
    throw new ConfigPatchError(`配置项「${pathText}」只能为「${String(node.value)}」，收到「${raw}」`)
  }
  if (node.type === 'array' || node.type === 'tuple') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      const parsed = parseJsonLike(trimmed, `配置项「${pathText}」`)
      if (!Array.isArray(parsed)) throw new ConfigPatchError(`配置项「${pathText}」需要数组`)
      assertSafeObject(parsed, `配置项「${pathText}」`)
      return parsed
    }
    return trimmed.split(',').map((part, index) => {
      const itemNode = node.type === 'tuple' ? (node.list?.[index] ?? null) : (node.inner ?? null)
      return coerceValue(part.trim(), itemNode, `${pathText}[${index}]`)
    })
  }
  if (node.type === 'object' || node.type === 'dict' || node.type === 'intersect') {
    const parsed = parseJsonLike(raw.trim(), `配置项「${pathText}」`)
    if (!isPlainObject(parsed)) throw new ConfigPatchError(`配置项「${pathText}」需要 JSON 对象`)
    assertSafeObject(parsed, `配置项「${pathText}」`)
    return parsed
  }
  if (node.type === 'union') {
    const view = classifyUnion(node)
    if (view.kind === 'select') {
      for (const option of view.options) {
        if (typeof option.value === 'string' && raw === option.value) return option.value
        if (typeof option.value === 'boolean' && parseBool(raw) === option.value) return option.value
        if (typeof option.value === 'number' && parseNumber(raw) === option.value) return option.value
      }
      const choices = view.options.map(option => String(option.value)).join(' / ')
      throw new ConfigPatchError(`配置项「${pathText}」可选值为 ${choices}，收到「${raw}」`)
    }
    if (view.kind === 'optional') {
      if (raw.trim() === 'null') return null
      return coerceValue(raw, view.inner, pathText)
    }
    if (view.kind === 'single') {
      return coerceValue(raw, view.inner, pathText)
    }
    if (view.kind === 'toggle') {
      const flag = parseBool(raw)
      if (flag === false) return false
      if (flag === true && unwrap(view.on)?.type === 'object') return {}
      return coerceValue(raw, view.on, pathText)
    }
    const members = node.list ?? []
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = parseJsonLike(trimmed, `配置项「${pathText}」`)
      assertSafeObject(parsed, `配置项「${pathText}」`)
      return parsed
    }
    for (const member of members) {
      if (member.type === 'const' || member.type === 'boolean' || member.type === 'number' || member.type === 'natural' || member.type === 'percent') {
        try { return coerceValue(raw, member, pathText) } catch { /* try next branch */ }
      }
    }
    if (members.some(member => member.type === 'string')) return raw
    return coerceFallback(raw)
  }
  return coerceFallback(raw)
}

function mergeObject(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  node: SchemaNode | null,
  at: string[],
  label?: string,
): Record<string, unknown> {
  assertSafeObject(patch, label ? `${label} 配置` : '配置')
  const dict = objectDictOf(node, { ...target, ...patch })
  const next: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    const childPath = [...at, key]
    const childNode = dict ? dict[key] : (unwrap(node)?.type === 'dict' ? (unwrap(node)?.inner ?? null) : null)
    if (dict && !Object.hasOwn(dict, key)) {
      throw unknownFieldError(label, childPath.join('.'), dict)
    }
    if (isPlainObject(value) && isMergeableObjectNode(childNode ?? null, isPlainObject(next[key]) ? { ...next[key], ...value } : value)) {
      const base = isPlainObject(next[key]) ? next[key] as Record<string, unknown> : {}
      next[key] = mergeObject(base, value, childNode ?? null, childPath, label)
    } else if (Array.isArray(value)) {
      const resolvedChild = unwrap(childNode ?? null)
      if (resolvedChild?.type === 'array' || resolvedChild?.type === 'tuple') {
        next[key] = value.map((item, index) => {
          const itemNode = resolvedChild.type === 'tuple' ? (resolvedChild.list?.[index] ?? null) : (resolvedChild.inner ?? null)
          if (isPlainObject(item) && isMergeableObjectNode(itemNode, item)) {
            return mergeObject({}, item, itemNode, [...childPath, String(index)], label)
          }
          return structuredClone(item)
        })
      } else {
        next[key] = structuredClone(value)
      }
    } else {
      next[key] = structuredClone(value)
    }
  }
  return next
}

function setAtPath(
  root: Record<string, unknown>,
  path: string[],
  raw: string,
  rootNode: SchemaNode | null,
  label?: string,
): void {
  if (!path.length) throw new ConfigPatchError('配置项路径不能为空')
  for (const segment of path) {
    const selector = SELECTOR.exec(segment)
    const keys = selector ? [selector[1], selector[2]] : [segment]
    if (!segment || keys.some(key => FORBIDDEN_KEYS.has(key))) {
      throw new ConfigPatchError(`配置项路径「${path.join('.')}」包含非法段「${segment}」`)
    }
  }

  let container: unknown = root
  let schema: SchemaNode | null = rootNode
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    const isLast = i === path.length - 1
    const prefix = path.slice(0, i + 1).join('.')
    const resolved = unwrap(schema)

    if (resolved?.type === 'array' || resolved?.type === 'tuple' || Array.isArray(container)) {
      if (!Array.isArray(container)) throw new ConfigPatchError(`配置项「${prefix}」所在的父级不是数组`)
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        throw new ConfigPatchError(`配置项「${prefix}」需要非负整数数组下标，收到「${segment}」`)
      }
      const index = Number(segment)
      const itemNode = resolved?.type === 'tuple' ? (resolved.list?.[index] ?? null) : (resolved?.inner ?? null)
      if (index > container.length) {
        throw new ConfigPatchError(`配置项「${prefix}」数组下标越界（当前长度 ${container.length}，最大可用下标 ${container.length}）`)
      }
      if (isLast) {
        const value = coerceValue(raw, itemNode, prefix)
        const existing = container[index]
        if (isPlainObject(value) && isMergeableObjectNode(itemNode, isPlainObject(existing) ? { ...existing, ...value } : value)) {
          container[index] = mergeObject(isPlainObject(existing) ? existing : {}, value, itemNode, path, label)
        } else {
          container[index] = value
        }
        return
      }
      if (index === container.length || !container[index] || typeof container[index] !== 'object') {
        const nextSeg = path[i + 1]
        const nextResolved = unwrap(itemNode)
        container[index] = (nextResolved?.type === 'array' || nextResolved?.type === 'tuple') && /^(?:0|[1-9]\d*)$/.test(nextSeg) ? [] : {}
      }
      container = container[index]
      schema = itemNode
      continue
    }

    if (!isPlainObject(container)) {
      throw new ConfigPatchError(`配置项「${prefix}」的父级「${path.slice(0, i).join('.')}」不是对象`)
    }
    const selector = SELECTOR.exec(segment)
    if (selector) {
      if (isLast) throw new ConfigPatchError(`配置项「${prefix}」选中的是列表中的一项，要再写出它的字段`)
      const [, key, field, wanted] = selector
      const dict = objectDictOf(schema, container)
      if (dict && !Object.hasOwn(dict, key)) throw unknownFieldError(label, path.slice(0, i).concat(key).join('.'), dict)
      const listNode = unwrap(dict ? dict[key] : null)
      if (listNode && listNode.type !== 'array') throw new ConfigPatchError(`配置项「${prefix}」：「${key}」不是列表`)
      if (container[key] === undefined) container[key] = []
      const list = container[key]
      if (!Array.isArray(list)) throw new ConfigPatchError(`配置项「${prefix}」：「${key}」不是列表`)
      const itemNode = listNode?.inner ?? null
      let item = list.find(candidate => isPlainObject(candidate) && String(candidate[field]) === wanted)
      if (!item) {
        const fieldNode = objectDictOf(itemNode, { [field]: wanted })?.[field] ?? null
        item = { [field]: coerceValue(wanted, fieldNode, `${prefix}.${field}`) }
        list.push(item)
      }
      container = item
      schema = itemNode
      continue
    }
    const dict = objectDictOf(schema, container)
    if (dict && !Object.hasOwn(dict, segment)) {
      throw unknownFieldError(label, prefix, dict)
    }
    const childNode = dict ? dict[segment] : (resolved?.type === 'dict' ? (resolved.inner ?? null) : null)

    if (isLast) {
      const value = coerceValue(raw, childNode, prefix)
      const existing = container[segment]
      if (isPlainObject(value) && isMergeableObjectNode(childNode, isPlainObject(existing) ? { ...existing, ...value } : value)) {
        container[segment] = mergeObject(isPlainObject(existing) ? existing : {}, value, childNode, path, label)
      } else {
        container[segment] = value
      }
      return
    }

    const nextResolved = unwrap(childNode)
    const currentChild = container[segment]
    if (nextResolved?.type === 'array' || nextResolved?.type === 'tuple') {
      if (!Array.isArray(currentChild)) container[segment] = []
    } else if (!isPlainObject(currentChild)) {
      container[segment] = {}
    }
    container = container[segment]
    schema = childNode
  }
}

export function applyConfigPatches(
  current: unknown,
  node: SchemaNode | null,
  patches: readonly ConfigPatch[],
  label?: string,
): Record<string, unknown> {
  let result: Record<string, unknown> = isPlainObject(current) ? structuredClone(current) : {}
  for (const patch of patches) {
    if (patch.kind === 'merge') {
      result = mergeObject(result, patch.value, node, [], label)
    } else {
      setAtPath(result, patch.path, patch.raw, node, label)
    }
  }
  return result
}

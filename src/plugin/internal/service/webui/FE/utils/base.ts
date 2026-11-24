/**
 * Where this WebUI is served. At the root of its address normally; under `/i/<instance>` when the instance manager's
 * gateway serves several instances on one address. The page itself stays at that path (routes are in the hash), so
 * it is read from the location, nothing has to tell it.
 */
const PREFIXED = /^\/i\/([^/]+)(?:\/|$)/

const currentPath = () => (typeof location === 'undefined' ? '/' : location.pathname)

/** `/i/<instance>` under the gateway, else '' */
export function basePath(pathname = currentPath()): string {
  const match = PREFIXED.exec(pathname)
  return match ? `/i/${match[1]}` : ''
}

/** The instance the page is for, when the gateway serves it under its name */
export function pageInstance(pathname = currentPath()): string | undefined {
  const match = PREFIXED.exec(pathname)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/**
 * A root path (`/api/...`, `/plugin-webui/...`) of this instance, under the gateway's prefix. Anything else (a
 * relative path, another origin, a path of another instance) stays as it is, so applying it twice changes nothing.
 */
export function withBase(url: string, pathname = currentPath()): string {
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/i/')) return url
  if (url === '/api/manager' || url.startsWith('/api/manager/')) return url
  return basePath(pathname) + url
}

/** The page of another instance, under the gateway */
export function instanceHref(name: string): string {
  return `/i/${encodeURIComponent(name)}/`
}

/** Scopes a browser storage key to the current instance under the gateway; unchanged at root. */
export function instanceStorageKey(key: string, pathname = currentPath()): string {
  const name = pageInstance(pathname)
  return name ? `${key}:${name}` : key
}

/**
 * The packages that moved to the @luckylillia-dev scope (2026-11-20), old name -> new name. Plugins published
 * before still import the old SDK name and declare their peers and llbot.dependencies by the old names, installs
 * still have the old packages on disk and their settings and data under the old names: all of it keeps working
 * as the new name (resolve-hook, manifest, the plugin service) and is moved over once (migrateRenamedPackages).
 */
export const RENAMED_PACKAGES: Readonly<Record<string, string>> = {
  '@luckylillia/plugin-sdk': '@luckylillia-dev/plugin-sdk',
  '@luckylillia/market': '@luckylillia-dev/market',
  '@luckylillia/plugin-nt-protocol': '@luckylillia-dev/plugin-nt-protocol',
  '@luckylillia/plugin-onebot11': '@luckylillia-dev/plugin-onebot11',
  '@luckylillia/plugin-milky': '@luckylillia-dev/plugin-milky',
  '@luckylillia/plugin-webqq': '@luckylillia-dev/plugin-webqq',
  '@luckylillia/plugin-ntqq-offline-email': '@luckylillia-dev/plugin-ntqq-offline-email',
  '@luckylillia/plugin-aiprovider': '@luckylillia-dev/plugin-aiprovider',
  '@luckylillia/plugin-repeat-mute': '@luckylillia-dev/plugin-repeat-mute',
  '@luckylillia/plugin-telegram-protocol': '@luckylillia-dev/plugin-telegram-protocol',
  '@luckylillia/plugin-theme-liuguang': '@luckylillia-dev/plugin-theme-liuguang',
  '@luckylillia/plugin-theme-paper': '@luckylillia-dev/plugin-theme-paper',
  'lucky-lillia-plugin-aiimgdetector': '@luckylillia-dev/plugin-aiimgdetector',
  'lucky-lillia-plugin-blipreview': '@luckylillia-dev/plugin-blipreview',
  'lucky-lillia-plugin-ffmpeg': '@luckylillia-dev/plugin-ffmpeg',
}

/** A package's name now: the new one for a renamed package, else as it is. */
export function currentPackageName(name: string): string {
  return Object.hasOwn(RENAMED_PACKAGES, name) ? RENAMED_PACKAGES[name] : name
}

/** The name a renamed package had before, if it was renamed. */
export function previousPackageName(name: string): string | undefined {
  return Object.keys(RENAMED_PACKAGES).find(old => RENAMED_PACKAGES[old] === name)
}

/** A record keyed by package names (peerDependencies, llbot.dependencies) with the old names as the new. */
export function withCurrentNames<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!record) return record
  const result: Record<string, T> = {}
  for (const [name, value] of Object.entries(record)) {
    const current = currentPackageName(name)
    // The new name wins when a package lists both
    if (current === name || !Object.hasOwn(record, current)) result[current] = value
  }
  return result
}

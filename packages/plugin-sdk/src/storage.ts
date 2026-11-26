/** `ctx.storage`: where a plugin keeps its own files. */
export interface PluginStorage {
  /**
   * Created on first use, shared by every entry of the package, kept when the plugin is uninstalled.
   *
   * - `'global'` (default): `data/instances/<instance>/plugin-data/<package>/shared/` (isolated per Bot instance).
   * - `'host'`: `data/plugin-data/<package>/` (shared across all Bot instances under the same `data/` directory,
   *   isolated per plugin package). Use for cross-instance credentials, per-account protocol databases, or large shared caches.
   */
  dir(scope?: 'global' | 'host'): Promise<string>
  /**
   * `data/instances/<instance>/plugin-data/<package>/bots/<platform>+<selfId>/`, one per bot, the QQ official bot's too; `bot` is the bot or
   * its sid. Needs no login. Existing legacy QQ directories are reused if no bot directory exists.
   */
  dir(scope: 'bot', bot: string | { sid: string }): Promise<string>
}

declare module 'cordis' {
  interface Context {
    storage: PluginStorage
  }
}

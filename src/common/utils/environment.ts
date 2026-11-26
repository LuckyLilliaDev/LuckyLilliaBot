import { existsSync } from "fs"

export function isDockerEnvironment(): boolean {
    try {
        return existsSync('/.dockerenv')
    } catch {
        return false
    }
}

/**
 * `--dev`: run against a local manager -- loads the development native bundle and reads data/auth_token.dev.txt.
 * argv only, no env fallback: a stray variable on a deployment must never switch it on.
 */
export function isDevMode(argv: string[] = process.argv): boolean {
    return argv.includes('--dev')
}

/** Extra plugin roots besides data/plugins: `--plugin-dir <path>`, repeatable. */
export function getPluginDirs(argv: string[] = process.argv): string[] {
    const dirs: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : undefined
        if (a === '--plugin-dir') {
            if (next) dirs.push(next)
        } else if (a.startsWith('--plugin-dir=')) {
            const v = a.slice('--plugin-dir='.length)
            if (v) dirs.push(v)
        }
    }
    return dirs
}

/** `--instance <name>` / `--instance=<name>`, else `LLBOT_INSTANCE`. Resolved against data/ in common/instance.ts. */
export function getInstanceArg(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--instance' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
        if (a.startsWith('--instance=')) return a.slice('--instance='.length) || undefined
    }
    return env.LLBOT_INSTANCE || undefined
}

/** `--plugin-hmr`: watch the plugin roots and hot-reload a package when its files change. */
export function isPluginHmr(argv: string[] = process.argv): boolean {
    return argv.includes('--plugin-hmr')
}

/** `-q <uin>` / `--qq <uin>`: without --instance, the instance named after that QQ number is used if there is one. */
export function getSpecifiedUin(argv: string[] = process.argv): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if ((a === '-q' || a === '--qq') && i + 1 < argv.length) return argv[i + 1]
        if (a.startsWith('-q=')) return a.slice('-q='.length)
        if (a.startsWith('--qq=')) return a.slice('--qq='.length)
    }
    return undefined
}

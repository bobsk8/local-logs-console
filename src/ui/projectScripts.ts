import * as fs from 'fs';
import * as path from 'path';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface ProjectScript {
    name: string;
    /** The script body from package.json (shown as the QuickPick detail). */
    body: string;
    /** Shell command that runs it with the folder's package manager. */
    command: string;
}

/** Lockfile → package manager; npm when there is none. */
export function detectPackageManager(folder: string): PackageManager {
    const has = (name: string) => fs.existsSync(path.join(folder, name));
    if (has('pnpm-lock.yaml')) { return 'pnpm'; }
    if (has('yarn.lock')) { return 'yarn'; }
    if (has('bun.lockb') || has('bun.lock')) { return 'bun'; }
    return 'npm';
}

export function scriptCommand(manager: PackageManager, name: string): string {
    const quoted = /^[\w:.@/-]+$/.test(name) ? name : JSON.stringify(name);
    return manager === 'yarn' ? `yarn ${quoted}` : `${manager} run ${quoted}`;
}

/** The `scripts` of `<folder>/package.json`, in file order; [] when there is none. */
export function readProjectScripts(folder: string): ProjectScript[] {
    let pkg: unknown;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    } catch {
        return [];
    }
    const scripts = (pkg as { scripts?: unknown } | null)?.scripts;
    if (!scripts || typeof scripts !== 'object') { return []; }
    const manager = detectPackageManager(folder);
    return Object.entries(scripts as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        // npm lifecycle hooks (pre*/post*) run on their own
        .filter(([name]) => !/^(pre|post)/.test(name) || !(name.replace(/^(pre|post)/, '') in (scripts as object)))
        .map(([name, body]) => ({ name, body, command: scriptCommand(manager, name) }));
}

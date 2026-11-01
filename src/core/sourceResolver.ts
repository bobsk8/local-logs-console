import * as fs from 'fs';
import * as path from 'path';

/**
 * Maps a path printed in a stack frame to a real file on disk. vscode-free
 * (roots are injected) so it is testable with plain Node.
 *
 * Only files inside the workspace roots (or the capture's working directory)
 * resolve: a log line is untrusted text, so a clickable frame must never be a
 * way to open arbitrary files on the machine without the user noticing.
 */
export class SourceResolver {
    private readonly cache = new Map<string, string | null>();

    constructor(private readonly roots: () => readonly string[]) {}

    /** Resolves synchronously (cached). Bare file names (Java) return undefined — use `resolveAsync`. */
    resolve(file: string, cwd?: string): string | undefined {
        const key = file + '\u0000' + (cwd ?? '');
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached ?? undefined;
        }
        const found = this.lookup(file, cwd);
        if (this.cache.size > 2000) { this.cache.clear(); }
        this.cache.set(key, found ?? null);
        return found;
    }

    /**
     * Like `resolve`, plus a workspace search for bare file names
     * (`UserService.java`) via the injected finder. Used for explicit clicks only.
     */
    async resolveAsync(file: string, cwd: string | undefined, findByName: (name: string) => Promise<string[]>): Promise<string | undefined> {
        const direct = this.resolve(file, cwd);
        if (direct) { return direct; }
        if (!/[\\/]/.test(file)) {
            const hits = await findByName(file);
            return hits.find(hit => this.isInside(hit, cwd));
        }
        return undefined;
    }

    /** Clears cached lookups (files appear and disappear while developing). */
    reset(): void {
        this.cache.clear();
    }

    /** True when `file` lies inside a workspace root or the capture's working directory. */
    isInside(file: string, cwd?: string): boolean {
        const bases = cwd ? [...this.roots(), cwd] : this.roots();
        return bases.some(base => isWithin(base, file));
    }

    private lookup(file: string, cwd?: string): string | undefined {
        if (!file || file.includes('\u0000')) { return undefined; }
        const candidates: string[] = [];
        if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
            candidates.push(path.normalize(file));
            // containers print /app/src/x.ts — try the tail under each root
            if (file.startsWith('/')) {
                const parts = file.split('/').filter(Boolean);
                for (let i = 1; i < parts.length; i++) {
                    for (const base of this.bases(cwd)) {
                        candidates.push(path.join(base, ...parts.slice(i)));
                    }
                }
            }
        } else if (/[\\/]/.test(file) || /\.\w+$/.test(file)) {
            for (const base of this.bases(cwd)) {
                candidates.push(path.resolve(base, file));
            }
        }
        for (const candidate of candidates) {
            if (this.isInside(candidate, cwd) && isFile(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    private bases(cwd?: string): string[] {
        return cwd ? [cwd, ...this.roots()] : [...this.roots()];
    }
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isWithin(base: string, file: string): boolean {
    const rel = path.relative(base, file);
    if (rel === '') { return false; }
    const caseFold = process.platform === 'win32' || process.platform === 'darwin';
    const relCmp = caseFold ? path.relative(base.toLowerCase(), file.toLowerCase()) : rel;
    return !relCmp.startsWith('..') && !path.isAbsolute(relCmp);
}

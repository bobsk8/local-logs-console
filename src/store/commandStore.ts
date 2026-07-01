import * as vscode from 'vscode';

/**
 * Persists the list of commands the user has run, scoped to the current
 * workspace via `workspaceState`. Mirrors the shape of LogStore but backs onto
 * a Memento so the list survives reloads. Most-recent-first, deduped by trim,
 * capped at MAX_COMMANDS.
 */
export class CommandStore {
    private static readonly KEY = 'local-log-viewer.savedCommands';
    private static readonly MAX_COMMANDS = 20;

    private cache: string[];

    constructor(private readonly memento: vscode.Memento) {
        this.cache = memento.get<string[]>(CommandStore.KEY, []).slice();
    }

    getAll(): string[] {
        return [...this.cache];
    }

    last(): string | undefined {
        return this.cache[0];
    }

    add(command: string): void {
        const cmd = (command || '').trim();
        if (!cmd) {
            return;
        }
        this.cache = [cmd, ...this.cache.filter(c => c !== cmd)].slice(0, CommandStore.MAX_COMMANDS);
        void this.memento.update(CommandStore.KEY, this.cache);
    }

    remove(command: string): void {
        const cmd = (command || '').trim();
        this.cache = this.cache.filter(c => c !== cmd);
        void this.memento.update(CommandStore.KEY, this.cache);
    }
}

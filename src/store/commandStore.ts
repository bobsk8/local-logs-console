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
    // Plain callbacks (not vscode.EventEmitter) so the module stays requireable
    // from the plain-Node test scripts.
    private listeners: Array<() => void> = [];

    constructor(private readonly memento: vscode.Memento) {
        this.cache = memento.get<string[]>(CommandStore.KEY, []).slice();
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            }
        };
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try { listener(); } catch { /* listener error */ }
        }
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
        this.notify();
    }

    remove(command: string): void {
        const cmd = (command || '').trim();
        this.cache = this.cache.filter(c => c !== cmd);
        void this.memento.update(CommandStore.KEY, this.cache);
        this.notify();
    }

    /** Edits a command in place (keeps its MRU position), deduping any other copy. */
    replace(oldCommand: string, newCommand: string): void {
        const oldCmd = (oldCommand || '').trim();
        const newCmd = (newCommand || '').trim();
        if (!newCmd || oldCmd === newCmd) {
            return;
        }
        this.cache = this.cache
            .map(c => (c === oldCmd ? newCmd : c))
            .filter((c, i, arr) => arr.indexOf(c) === i);
        void this.memento.update(CommandStore.KEY, this.cache);
        this.notify();
    }
}

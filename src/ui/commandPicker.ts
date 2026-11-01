import * as vscode from 'vscode';
import { CommandStore } from '../store/commandStore';
import { readProjectScripts } from './projectScripts';

export interface PickedCommand {
    command: string;
    /** Working directory; undefined = the first workspace folder. */
    cwd?: string;
}

interface CommandItem extends vscode.QuickPickItem {
    command?: string;
    cwd?: string;
    saved?: boolean;
}

/**
 * QuickPick of saved commands (each removable), the package.json scripts of
 * every workspace folder, and a "New command…" entry. Resolves to the chosen
 * command and its folder, or undefined if cancelled.
 */
export function pickCommand(commandStore: CommandStore): Promise<PickedCommand | undefined> {
    return new Promise<PickedCommand | undefined>(resolve => {
        const qp = vscode.window.createQuickPick<CommandItem>();
        qp.title = 'Run and capture command';
        qp.placeholder = 'Pick a saved command or a project script, or type a new command';
        qp.matchOnDescription = true;

        const folders = vscode.workspace.workspaceFolders ?? [];
        const firstFolder = folders[0]?.uri.fsPath;
        const scriptSections: CommandItem[] = [];
        for (const folder of folders) {
            const scripts = readProjectScripts(folder.uri.fsPath);
            if (scripts.length === 0) { continue; }
            scriptSections.push({
                label: folders.length > 1 ? `Scripts · ${folder.name}` : 'Scripts',
                kind: vscode.QuickPickItemKind.Separator
            });
            for (const script of scripts) {
                scriptSections.push({
                    label: `$(play) ${script.name}`,
                    description: script.command,
                    detail: script.body,
                    command: script.command,
                    cwd: folder.uri.fsPath
                });
            }
        }

        const trashButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };
        const NEW_ITEM: CommandItem = { label: '$(add) New command…', alwaysShow: true };
        const buildItems = (): CommandItem[] => {
            const saved = commandStore.getAll();
            return [
                NEW_ITEM,
                ...(saved.length > 0 ? [{ label: 'Saved', kind: vscode.QuickPickItemKind.Separator } as CommandItem] : []),
                ...saved.map(cmd => ({ label: cmd, command: cmd, saved: true, buttons: [trashButton] })),
                ...scriptSections
            ];
        };
        qp.items = buildItems();

        let done = false;
        let awaitingInput = false; // suppress onDidHide while the input box is open
        const finish = (value: PickedCommand | undefined) => {
            if (done) { return; }
            done = true;
            qp.dispose();
            resolve(value);
        };

        qp.onDidTriggerItemButton(e => {
            if (e.item.command) {
                commandStore.remove(e.item.command);
            }
            qp.items = buildItems();
        });

        qp.onDidAccept(async () => {
            const picked = qp.selectedItems[0];
            if (!picked) { return; }
            if (picked === NEW_ITEM) {
                awaitingInput = true;
                const typed = qp.value.trim();
                qp.hide();
                const cmd = await vscode.window.showInputBox({ prompt: 'Command to run (e.g. npm run dev)', placeHolder: 'Shell command', value: typed });
                if (!cmd || !cmd.trim()) { finish(undefined); return; }
                commandStore.add(cmd);
                finish({ command: cmd.trim() });
            } else if (picked.command) {
                // saved commands always run in the first folder — only save scripts that run there
                if (picked.saved || !picked.cwd || picked.cwd === firstFolder) {
                    commandStore.add(picked.command);
                }
                finish({ command: picked.command, cwd: picked.cwd });
            }
        });

        qp.onDidHide(() => { if (!awaitingInput) { finish(undefined); } });
        qp.show();
    });
}

/**
 * Management QuickPick: every saved command with inline edit + remove buttons.
 * Accepting an item resolves to that command so the caller can run it;
 * resolves undefined on cancel.
 */
export function manageSavedCommands(commandStore: CommandStore): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
        const qp = vscode.window.createQuickPick();
        qp.title = 'Manage Saved Commands';
        qp.placeholder = 'Enter runs the selected command; use the icons to edit or remove';

        const editButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit' };
        const trashButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };
        const buildItems = (): vscode.QuickPickItem[] =>
            commandStore.getAll().map(cmd => ({ label: cmd, buttons: [editButton, trashButton] }));
        qp.items = buildItems();

        let done = false;
        let awaitingInput = false;
        const finish = (value: string | undefined) => {
            if (done) { return; }
            done = true;
            qp.dispose();
            resolve(value);
        };

        qp.onDidTriggerItemButton(async e => {
            if (e.button === trashButton) {
                commandStore.remove(e.item.label);
                qp.items = buildItems();
                if (qp.items.length === 0) {
                    finish(undefined);
                }
                return;
            }

            awaitingInput = true;
            qp.hide();
            const updated = await vscode.window.showInputBox({
                prompt: 'Edit command',
                value: e.item.label,
                placeHolder: 'Shell command'
            });
            if (updated && updated.trim()) {
                commandStore.replace(e.item.label, updated);
            }
            awaitingInput = false;
            qp.items = buildItems();
            qp.show();
        });

        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            if (picked) {
                finish(picked.label);
            }
        });

        qp.onDidHide(() => { if (!awaitingInput) { finish(undefined); } });
        qp.show();
    });
}

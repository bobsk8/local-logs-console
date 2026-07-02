import * as vscode from 'vscode';
import { CommandStore } from '../store/commandStore';

/**
 * QuickPick of saved commands (each removable) plus a "New command…" entry.
 * Resolves to the chosen/typed command, or undefined if cancelled.
 */
export function pickCommand(commandStore: CommandStore): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
        const NEW_LABEL = '$(add) New command…';
        const qp = vscode.window.createQuickPick();
        qp.title = 'Run and capture command';
        qp.placeholder = 'Pick a saved command or create a new one';

        const trashButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' };
        const buildItems = (): vscode.QuickPickItem[] => [
            { label: NEW_LABEL },
            ...commandStore.getAll().map(cmd => ({ label: cmd, buttons: [trashButton] }))
        ];
        qp.items = buildItems();

        let done = false;
        let awaitingInput = false; // suppress onDidHide while the input box is open
        const finish = (value: string | undefined) => {
            if (done) { return; }
            done = true;
            qp.dispose();
            resolve(value);
        };

        qp.onDidTriggerItemButton(e => {
            commandStore.remove(e.item.label);
            qp.items = buildItems();
        });

        qp.onDidAccept(async () => {
            const picked = qp.selectedItems[0];
            if (!picked) { return; }
            if (picked.label === NEW_LABEL) {
                awaitingInput = true;
                qp.hide();
                const cmd = await vscode.window.showInputBox({ prompt: 'Command to run (e.g. npm run dev)', placeHolder: 'Shell command' });
                if (!cmd || !cmd.trim()) { finish(undefined); return; }
                commandStore.add(cmd);
                finish(cmd.trim());
            } else {
                commandStore.add(picked.label);
                finish(picked.label);
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

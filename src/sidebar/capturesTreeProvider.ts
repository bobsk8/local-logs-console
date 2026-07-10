import * as vscode from 'vscode';
import { SessionRegistry, CaptureSession } from '../core/sessionRegistry';
import { CommandStore } from '../store/commandStore';

type TreeNode = DashboardItem | AddCommandItem | SectionItem | CaptureItem | SavedCommandItem;

class DashboardItem extends vscode.TreeItem {
    constructor() {
        super('📊 Dashboard', vscode.TreeItemCollapsibleState.None);
        this.id = 'dashboard-action';
        this.contextValue = 'dashboardAction';
        this.command = {
            command: 'local-log-viewer.openDashboard',
            title: 'Open Dashboard'
        };
        this.tooltip = 'Open the log viewer dashboard';
        this.description = 'View & manage logs';
    }
}

class AddCommandItem extends vscode.TreeItem {
    constructor() {
        super('➕ Add new command', vscode.TreeItemCollapsibleState.None);
        this.id = 'add-command-action';
        this.contextValue = 'addCommandAction';
        this.command = {
            command: 'local-log-viewer.addNewCommand',
            title: 'Add New Command'
        };
        this.tooltip = 'Add a new command to saved commands';
        this.description = 'Save a new command';
    }
}

class SectionItem extends vscode.TreeItem {
    constructor(
        public readonly section: 'captures' | 'commands',
        label: string,
        count: number
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'section';
        this.description = String(count);
    }
}

class CaptureItem extends vscode.TreeItem {
    constructor(public readonly session: CaptureSession) {
        super(session.label, vscode.TreeItemCollapsibleState.None);
        this.id = 'capture:' + session.id;
        this.contextValue = 'activeCapture';
        this.iconPath = new vscode.ThemeIcon(session.kind === 'file' ? 'file' : 'terminal');
        this.description = formatElapsed(session.startedAt);
        this.tooltip = (session.kind === 'file' ? 'Following file: ' : 'Running: ') + session.label;
        this.command = {
            command: 'local-log-viewer.openDashboard',
            title: 'Open Dashboard'
        };
    }
}

class SavedCommandItem extends vscode.TreeItem {
    constructor(public readonly commandText: string) {
        super(commandText, vscode.TreeItemCollapsibleState.None);
        this.id = 'saved:' + commandText;
        this.contextValue = 'savedCommand';
        this.iconPath = new vscode.ThemeIcon('terminal');
        this.tooltip = 'Saved command — run, edit or remove';
    }
}

function formatElapsed(startedAt: number): string {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (s < 60) { return `running · ${s}s`; }
    const m = Math.floor(s / 60);
    if (m < 60) { return `running · ${m}m`; }
    const h = Math.floor(m / 60);
    return `running · ${h}h ${m % 60}m`;
}

/**
 * Sidebar tree: live capture sessions (with inline stop) and saved commands
 * (run / edit / remove). When both lists are empty the tree renders nothing,
 * which lets the `viewsWelcome` onboarding content show instead.
 */
export class CapturesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
    public readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: Array<{ dispose(): void }> = [];

    constructor(
        private readonly registry: SessionRegistry,
        private readonly commandStore: CommandStore
    ) {
        this.disposables.push(
            registry.onDidChangeSessions(() => this.emitter.fire()),
            commandStore.onDidChange(() => this.emitter.fire())
        );
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!element) {
            const items: TreeNode[] = [];

            const sessions = this.registry.getAll();
            const commands = this.commandStore.getAll();

            // Only show Dashboard if there are captures or commands
            // Otherwise return empty so viewsWelcome can show onboarding
            if (sessions.length > 0 || commands.length > 0) {
                items.push(new DashboardItem());
            }

            if (sessions.length > 0) {
                items.push(new SectionItem('captures', 'Active Captures', sessions.length));
            }
            // Show Saved Commands section whenever there are captures or commands,
            // even if zero commands saved — this ensures "Add new command" is reachable.
            if (sessions.length > 0 || commands.length > 0) {
                items.push(new SectionItem('commands', 'Saved Commands', commands.length));
            }
            return items;
        }
        if (element instanceof SectionItem) {
            const children: TreeNode[] = [];
            if (element.section === 'captures') {
                return this.registry.getAll().map(s => new CaptureItem(s));
            }
            // Saved Commands section: show "Add new" item first, then saved commands
            children.push(new AddCommandItem());
            children.push(...this.commandStore.getAll().map(c => new SavedCommandItem(c)));
            return children;
        }
        return [];
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.emitter.dispose();
    }
}

export { CaptureItem, SavedCommandItem };

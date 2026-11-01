import { LogEntry } from '../models/logEntry';
import { parseStackFrame, isLibraryFrame, StackFrame } from '../shared/stackFrames';
import { formatClock } from './lib/format';

export type DetailTab = 'overview' | 'context' | 'json';

export interface ContextView {
    /** Neighbouring entries (in order), including the anchor. */
    rows: Array<{ index: number; entry: LogEntry }>;
    /** logsData index of the opened entry. */
    anchorIndex: number;
    /** What the neighbours share ("api", "same capture"). */
    scope: string;
}

export interface DetailPanelDeps {
    panel: HTMLElement;
    resizer: HTMLElement | null;
    dashboard: HTMLElement | null;
    attributesTable: HTMLElement;
    messageContent: HTMLElement;
    jsonContent: HTMLElement;
    closeBtn: HTMLElement | null;
    expandAllBtn: HTMLElement | null;
    collapseAllBtn: HTMLElement | null;
    copyMessageBtn: HTMLElement | null;
    copyJsonBtn: HTMLElement | null;
    redactedBadge: HTMLElement | null;
    bookmarkBtn: HTMLElement | null;
    stackSection: HTMLElement | null;
    stackList: HTMLElement | null;
    stackCount: HTMLElement | null;
    contextList: HTMLElement | null;
    contextTitle: HTMLElement | null;
    correlationBox: HTMLElement | null;
    initialTab: DetailTab;
    /** Attribute value clicked — add a field:value token to the search filter. */
    onAttributeClick: (dottedKey: string, valueText: string) => void;
    /** Close button clicked — clear selection state in the caller. */
    onClose: () => void;
    /** Resize drag finished — re-render the list window + persist. */
    onResizeEnd: () => void;
    onTabChange: (tab: DetailTab) => void;
    /** A stack-frame location was clicked — open it in the editor. */
    onOpenFrame: (frame: StackFrame, log: LogEntry) => void;
    getContext: (log: LogEntry) => ContextView | null;
    /** How many loaded entries share this correlation id. */
    correlationCount: (correlationId: string) => number;
    onContextClick: (index: number) => void;
    isBookmarked: (id: string) => boolean;
    onToggleBookmark: (log: LogEntry) => void;
}

const TABS: DetailTab[] = ['overview', 'context', 'json'];

/**
 * The detail panel: Overview (message, clickable stack, attributes), Context
 * (neighbouring lines of the same capture, the whole request) and JSON (raw
 * tree). All log content is rendered via textContent — never innerHTML.
 */
export class DetailPanel {
    private currentLog: LogEntry | null = null;
    private tab: DetailTab;
    /** The context tab renders lazily — only when it is visible. */
    private contextStale = true;

    constructor(private readonly deps: DetailPanelDeps) {
        const { closeBtn, expandAllBtn, collapseAllBtn, copyMessageBtn, copyJsonBtn, bookmarkBtn } = deps;
        this.tab = deps.initialTab;

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.close();
                this.deps.onClose();
            });
        }
        if (expandAllBtn) {
            expandAllBtn.addEventListener('click', () => this.setAllTreeNodesCollapsed(false));
        }
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', () => this.setAllTreeNodesCollapsed(true));
        }
        if (copyMessageBtn) {
            copyMessageBtn.addEventListener('click', () => {
                const log = this.currentLog;
                const text = log ? String(log.message || '') + (log.stack?.length ? '\n' + log.stack.join('\n') : '') : '';
                this.copyToClipboard(copyMessageBtn, text);
            });
        }
        if (copyJsonBtn) {
            copyJsonBtn.addEventListener('click', () => {
                let text = '';
                try {
                    text = JSON.stringify(this.currentLog?.raw ?? {}, null, 2);
                } catch {
                    text = String(this.currentLog?.message || '');
                }
                this.copyToClipboard(copyJsonBtn, text);
            });
        }
        if (bookmarkBtn) {
            bookmarkBtn.addEventListener('click', () => {
                if (this.currentLog) {
                    this.deps.onToggleBookmark(this.currentLog);
                    this.syncBookmark();
                }
            });
        }

        const tabButtons = TABS.map(t => document.getElementById('tab-' + t));
        tabButtons.forEach((btn, i) => {
            if (!btn) { return; }
            btn.addEventListener('click', () => this.selectTab(TABS[i]));
            btn.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') { return; }
                const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
                this.selectTab(TABS[next]);
                tabButtons[next]?.focus();
                e.preventDefault();
            });
        });
        this.applyTab();

        this.setupResizer();
    }

    open(log: LogEntry): void {
        this.currentLog = log;
        this.renderAttributesTable(log.raw);
        this.renderMessageBlock(log);
        this.renderStack(log);
        this.renderJsonTree(log.raw);
        this.contextStale = true;
        if (this.tab === 'context') { this.renderContext(); }
        if (this.deps.redactedBadge) {
            this.deps.redactedBadge.hidden = !log.redacted;
        }
        this.syncBookmark();
        // classes, not inline display — the narrow-layout media query must win
        this.deps.panel.classList.add('open');
        this.deps.dashboard?.classList.add('detail-open');
    }

    isOpen(): boolean {
        return this.deps.panel.classList.contains('open');
    }

    /** Re-reads the bookmark state (after `b` in the list). */
    syncBookmark(): void {
        const btn = this.deps.bookmarkBtn;
        if (!btn || !this.currentLog) { return; }
        const on = this.deps.isBookmarked(this.currentLog.id);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this line');
    }

    /** The context tab shows live neighbours — refresh it when new lines arrive. */
    markContextStale(): void {
        this.contextStale = true;
        if (this.isOpen() && this.tab === 'context') {
            this.renderContext();
        }
    }

    selectTab(tab: DetailTab): void {
        if (tab === this.tab) { return; }
        this.tab = tab;
        this.applyTab();
        if (tab === 'context' && this.contextStale) { this.renderContext(); }
        this.deps.onTabChange(tab);
    }

    private applyTab(): void {
        for (const t of TABS) {
            const btn = document.getElementById('tab-' + t);
            const pane = document.getElementById('pane-' + t);
            const selected = t === this.tab;
            if (btn) {
                btn.setAttribute('aria-selected', selected ? 'true' : 'false');
                btn.tabIndex = selected ? 0 : -1;
            }
            if (pane) { pane.hidden = !selected; }
        }
    }

    private copyToClipboard(button: HTMLElement, text: string): void {
        navigator.clipboard.writeText(text).then(() => {
            const original = button.textContent;
            button.textContent = 'Copied ✓';
            setTimeout(() => { button.textContent = original; }, 1200);
        }).catch(() => {
            // clipboard unavailable — ignore
        });
    }

    close(): void {
        this.deps.panel.classList.remove('open');
        this.deps.dashboard?.classList.remove('detail-open');
        this.currentLog = null;
    }

    setWidth(width: string): void {
        this.deps.panel.style.width = width;
    }

    getWidth(): string | undefined {
        return this.deps.panel.style.width || undefined;
    }

    private renderAttributesTable(obj: unknown, prefix = ''): void {
        const { attributesTable } = this.deps;
        if (prefix === '') { attributesTable.innerHTML = ''; }
        if (typeof obj !== 'object' || obj === null) {
            return;
        }

        for (const key in obj as Record<string, unknown>) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                if (prefix === '' && key === '__hasLevelMarker') { continue; }
                const val = (obj as Record<string, unknown>)[key];
                const currentKey = prefix ? prefix + '.' + key : key;
                if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                    this.renderAttributesTable(val, currentKey);
                } else {
                    const tr = document.createElement('tr');
                    const tdKey = document.createElement('td');
                    tdKey.className = 'attr-key';
                    tdKey.textContent = currentKey;
                    const tdVal = document.createElement('td');
                    tdVal.className = 'attr-val attr-val-clickable';
                    const valText = typeof val === 'object' ? JSON.stringify(val) : String(val);
                    tdVal.textContent = valText;
                    tdVal.title = 'Click to filter by this value';
                    tdVal.addEventListener('click', () => this.deps.onAttributeClick(currentKey, valText));
                    tr.appendChild(tdKey);
                    tr.appendChild(tdVal);
                    attributesTable.appendChild(tr);
                }
            }
        }
    }

    private renderMessageBlock(logEntry: LogEntry): void {
        const directMessage = logEntry && logEntry.message ? String(logEntry.message) : '';
        const raw = logEntry && logEntry.raw && typeof logEntry.raw === 'object' ? logEntry.raw as Record<string, unknown> : undefined;
        const rawMessage = raw && raw['message'] ? String(raw['message']) : '';
        this.deps.messageContent.textContent = directMessage || rawMessage || '(message not available)';
    }

    /** Stack lines with clickable file:line locations (resolved by the extension host). */
    private renderStack(log: LogEntry): void {
        const { stackSection, stackList, stackCount } = this.deps;
        if (!stackSection || !stackList) { return; }
        stackList.textContent = '';
        const lines = log.stack ?? [];
        stackSection.hidden = lines.length === 0;
        if (lines.length === 0) { return; }
        if (stackCount) { stackCount.textContent = `· ${lines.length} line${lines.length === 1 ? '' : 's'}`; }

        for (const text of lines) {
            const li = document.createElement('li');
            li.className = 'stack-line';
            const frame = parseStackFrame(text);
            if (!frame) {
                li.textContent = text;
            } else {
                li.classList.add(isLibraryFrame(frame) ? 'library' : 'app');
                li.appendChild(document.createTextNode(text.slice(0, frame.start)));
                const link = document.createElement('button');
                link.type = 'button';
                link.className = 'frame-link';
                link.textContent = text.slice(frame.start, frame.end);
                link.title = `Open ${frame.file}:${frame.line} in the editor`;
                link.addEventListener('click', () => this.deps.onOpenFrame(frame, log));
                li.appendChild(link);
                li.appendChild(document.createTextNode(text.slice(frame.end)));
            }
            stackList.appendChild(li);
        }
    }

    private renderContext(): void {
        const { contextList, contextTitle, correlationBox } = this.deps;
        const log = this.currentLog;
        this.contextStale = false;
        if (!contextList || !log) { return; }
        contextList.textContent = '';

        if (correlationBox) {
            correlationBox.textContent = '';
            const id = log.correlationId;
            correlationBox.hidden = !id;
            if (id) {
                const count = this.deps.correlationCount(id);
                correlationBox.appendChild(document.createTextNode('Request '));
                const idEl = document.createElement('span');
                idEl.className = 'correlation-id';
                idEl.textContent = id;
                correlationBox.appendChild(idEl);
                correlationBox.appendChild(document.createTextNode(` · ${count} line${count === 1 ? '' : 's'}`));
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'json-action-btn';
                btn.textContent = 'Show only this request';
                btn.addEventListener('click', () => this.deps.onAttributeClick('correlationId', id));
                correlationBox.appendChild(btn);
            }
        }

        const view = this.deps.getContext(log);
        if (contextTitle) { contextTitle.textContent = view ? `Around this line · ${view.scope}` : 'Around this line'; }
        if (!view || view.rows.length <= 1) {
            const empty = document.createElement('li');
            empty.className = 'context-empty';
            empty.textContent = 'No other lines from this capture are loaded.';
            contextList.appendChild(empty);
            return;
        }
        let anchorEl: HTMLElement | null = null;
        for (const { index, entry } of view.rows) {
            const li = document.createElement('li');
            li.className = 'context-row';
            li.tabIndex = 0;
            const time = document.createElement('span');
            time.className = 'ctx-time';
            time.textContent = entry.timestamp ? formatClock(entry.timestamp) : '';
            const level = document.createElement('span');
            level.className = 'level-badge level-' + (entry.level || '').toLowerCase();
            level.textContent = (entry.level || '').slice(0, 4);
            const msg = document.createElement('span');
            msg.className = 'ctx-msg';
            msg.textContent = String(entry.message || '') + (entry.stack?.length ? `  +${entry.stack.length}` : '');
            msg.title = String(entry.message || '');
            li.appendChild(time);
            li.appendChild(level);
            li.appendChild(msg);
            if (index === view.anchorIndex) {
                li.classList.add('anchor');
                li.setAttribute('aria-current', 'true');
                anchorEl = li;
            } else {
                const open = () => this.deps.onContextClick(index);
                li.addEventListener('click', open);
                li.addEventListener('keydown', (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') { open(); e.preventDefault(); }
                });
            }
            contextList.appendChild(li);
        }
        const anchor = anchorEl as HTMLElement | null;
        if (anchor) {
            requestAnimationFrame(() => anchor.scrollIntoView({ block: 'center' }));
        }
    }

    private isExpandable(value: unknown): value is object {
        return typeof value === 'object' && value !== null;
    }

    private formatPrimitive(value: unknown): { text: string; className: string } {
        if (value === null) { return { text: 'null', className: 'json-null' }; }
        if (typeof value === 'string') { return { text: `"${value}"`, className: 'json-string' }; }
        if (typeof value === 'number') { return { text: String(value), className: 'json-number' }; }
        if (typeof value === 'boolean') { return { text: String(value), className: 'json-boolean' }; }
        return { text: String(value), className: 'json-unknown' };
    }

    private setNodeCollapsed(nodeEl: Element, collapsed: boolean): void {
        const toggle = nodeEl.querySelector(':scope > .json-line > .json-toggle');
        const children = nodeEl.querySelector(':scope > .json-children') as HTMLElement | null;
        if (!toggle || !children) { return; }

        toggle.textContent = collapsed ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        children.style.display = collapsed ? 'none' : 'block';
    }

    private createJsonNode(key: string, value: unknown, depth = 0): HTMLElement {
        const node = document.createElement('div');
        node.className = 'json-node';

        const line = document.createElement('div');
        line.className = 'json-line';
        line.style.paddingLeft = (depth * 16) + 'px';

        const keyEl = document.createElement('span');
        keyEl.className = 'json-key';
        keyEl.textContent = key;

        if (!this.isExpandable(value)) {
            const primitive = this.formatPrimitive(value);
            const valueEl = document.createElement('span');
            valueEl.className = `json-value ${primitive.className}`;
            valueEl.textContent = primitive.text;

            line.innerHTML = '<span class="json-toggle-spacer"></span>';
            line.appendChild(keyEl);
            line.appendChild(document.createTextNode(': '));
            line.appendChild(valueEl);
            node.appendChild(line);
            return node;
        }

        const isArray = Array.isArray(value);
        const size = isArray ? (value as unknown[]).length : Object.keys(value).length;
        const typeHint = isArray ? `[${size}]` : `{${size}}`;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'json-toggle';

        const typeEl = document.createElement('span');
        typeEl.className = 'json-type';
        typeEl.textContent = ` ${typeHint}`;

        const children = document.createElement('div');
        children.className = 'json-children';

        const entries: Array<[string, unknown]> = isArray
            ? (value as unknown[]).map((item, index) => [String(index), item] as [string, unknown])
            : Object.entries(value);

        for (const [childKey, childValue] of entries) {
            children.appendChild(this.createJsonNode(childKey, childValue, depth + 1));
        }

        // Top-level nodes start expanded; deeper nesting starts collapsed so a
        // large payload doesn't wall-of-text the panel. "Expand all" overrides.
        const collapsedByDefault = depth >= 1;

        const handleToggle = (ev: Event) => {
            ev.stopPropagation();
            const currentlyExpanded = toggle.getAttribute('aria-expanded') === 'true';
            this.setNodeCollapsed(node, currentlyExpanded);
        };

        toggle.addEventListener('click', handleToggle);
        line.addEventListener('click', handleToggle);

        line.appendChild(toggle);
        line.appendChild(keyEl);
        line.appendChild(document.createTextNode(':'));
        line.appendChild(typeEl);
        node.appendChild(line);
        node.appendChild(children);

        this.setNodeCollapsed(node, collapsedByDefault);
        return node;
    }

    private renderJsonTree(payload: unknown): void {
        const { jsonContent } = this.deps;
        jsonContent.innerHTML = '';

        let sanitizedPayload = payload;

        if (payload && typeof payload === 'object') {
            sanitizedPayload = JSON.parse(JSON.stringify(payload));
            delete (sanitizedPayload as Record<string, unknown>)['message'];
            delete (sanitizedPayload as Record<string, unknown>)['__hasLevelMarker'];
        }

        if (!this.isExpandable(sanitizedPayload)) {
            const root = this.createJsonNode('value', sanitizedPayload, 0);
            jsonContent.appendChild(root);
            return;
        }

        const rootContainer = document.createElement('div');
        rootContainer.className = 'json-root';

        const entries: Array<[string, unknown]> = Array.isArray(sanitizedPayload)
            ? (sanitizedPayload as unknown[]).map((item, index) => [String(index), item] as [string, unknown])
            : Object.entries(sanitizedPayload);

        for (const [childKey, childValue] of entries) {
            rootContainer.appendChild(this.createJsonNode(childKey, childValue, 0));
        }

        jsonContent.appendChild(rootContainer);
    }

    private setAllTreeNodesCollapsed(collapsed: boolean): void {
        this.deps.jsonContent.querySelectorAll('.json-node').forEach(node => {
            const hasChildren = !!node.querySelector(':scope > .json-children');
            if (hasChildren) {
                this.setNodeCollapsed(node, collapsed);
            }
        });
    }

    /** Drag the resizer to resize the detail panel. */
    private setupResizer(): void {
        const { resizer, dashboard, panel } = this.deps;
        if (!resizer || !dashboard) { return; }

        const MIN_W = 320;
        let dragging = false;
        resizer.addEventListener('pointerdown', (e) => {
            dragging = true;
            resizer.classList.add('dragging');
            try { resizer.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
        });
        resizer.addEventListener('pointermove', (e) => {
            if (!dragging) { return; }
            let w = dashboard.clientWidth - e.clientX;
            const maxW = dashboard.clientWidth * 0.8;
            if (w < MIN_W) { w = MIN_W; }
            if (w > maxW) { w = maxW; }
            panel.style.width = w + 'px';
        });
        const endDrag = (e: PointerEvent) => {
            if (!dragging) { return; }
            dragging = false;
            resizer.classList.remove('dragging');
            try { resizer.releasePointerCapture(e.pointerId); } catch { }
            this.deps.onResizeEnd();
        };
        resizer.addEventListener('pointerup', endDrag);
        resizer.addEventListener('pointercancel', endDrag);
    }
}

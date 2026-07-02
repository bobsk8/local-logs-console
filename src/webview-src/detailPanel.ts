import { LogEntry } from '../models/logEntry';

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
    /** Attribute value clicked — add a field:value token to the search filter. */
    onAttributeClick: (dottedKey: string, valueText: string) => void;
    /** Close button clicked — clear selection state in the caller. */
    onClose: () => void;
    /** Resize drag finished — re-render the list window + persist. */
    onResizeEnd: () => void;
}

/**
 * The right-hand detail panel: flattened attributes table (click-to-search),
 * message block and collapsible JSON tree. All log content is rendered via
 * textContent — never innerHTML.
 */
export class DetailPanel {
    private currentLog: LogEntry | null = null;

    constructor(private readonly deps: DetailPanelDeps) {
        const { closeBtn, expandAllBtn, collapseAllBtn, copyMessageBtn, copyJsonBtn } = deps;

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
                const text = this.deps.messageContent.textContent || '';
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

        this.setupResizer();
    }

    open(log: LogEntry): void {
        this.currentLog = log;
        this.renderAttributesTable(log.raw);
        this.renderMessageBlock(log);
        this.renderJsonTree(log.raw);
        if (this.deps.redactedBadge) {
            this.deps.redactedBadge.hidden = !log.redacted;
        }
        this.deps.panel.style.display = 'flex';
        if (this.deps.resizer) { this.deps.resizer.style.display = 'block'; }
    }

    isOpen(): boolean {
        return this.deps.panel.style.display === 'flex';
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
        this.deps.panel.style.display = 'none';
        if (this.deps.resizer) { this.deps.resizer.style.display = 'none'; }
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
                    tdVal.title = 'Click to add to search filter';
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
        const finalMessage = directMessage || rawMessage || '(message not available)';
        this.deps.messageContent.textContent = finalMessage;
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

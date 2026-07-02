import { BUFFER, UiState } from './state';
import { formatTimestamp, formatClock } from './lib/format';

export interface VirtualListDeps {
    container: HTMLElement;
    state: UiState;
    onRowClick: (index: number) => void;
    /** Copy the entry's raw JSON; feedbackEl is the button to flash "✓" on. */
    onCopyRow: (index: number, feedbackEl: HTMLElement) => void;
    onCountsChanged: () => void;
}

interface PooledRow {
    root: HTMLElement;
    tsEl: HTMLElement;
    levelEl: HTMLElement;
    sourceEl: HTMLElement;
    msgEl: HTMLElement;
    /** Index into logsData currently bound to this slot, or -1 when hidden. */
    boundIndex: number;
}

let nextRowDomId = 1;

/**
 * Windowed rendering over a fixed pool of row elements. Only rows inside the
 * viewport (± BUFFER) are bound; off-window slots are hidden, not destroyed —
 * no per-scroll node allocation. All log content flows through textContent,
 * so there is no HTML-injection surface here at all.
 */
export class VirtualList {
    private readonly spacer: HTMLDivElement;
    private readonly pool: PooledRow[] = [];
    /** logsData index that should get the live-append entrance animation. */
    private animateIndex = -1;

    constructor(private readonly deps: VirtualListDeps) {
        deps.container.innerHTML = '';
        this.spacer = document.createElement('div');
        this.spacer.style.position = 'relative';
        this.spacer.style.width = '100%';
        deps.container.appendChild(this.spacer);
        this.applyRowHeight();
    }

    /** Sync the --row-height CSS variable after a density change. */
    applyRowHeight(): void {
        this.deps.container.style.setProperty('--row-height', this.deps.state.rowHeight + 'px');
    }

    updateSpacer(): void {
        this.spacer.style.height = (this.deps.state.filteredIndexes.length * this.deps.state.rowHeight) + 'px';
    }

    clear(): void {
        for (const slot of this.pool) {
            slot.boundIndex = -1;
            slot.root.style.display = 'none';
        }
        this.spacer.style.height = '0px';
    }

    isAtBottom(): boolean {
        const { container } = this.deps;
        return container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
    }

    scrollToBottom(): void {
        this.deps.container.scrollTop = this.deps.container.scrollHeight;
    }

    /** Mark a just-appended entry for the (reduced-motion aware) entrance animation. */
    markLiveAppend(index: number): void {
        this.animateIndex = index;
    }

    /** Scroll the given visual row into view (keyboard navigation). */
    ensureVisible(visualRow: number): void {
        const { container, state } = this.deps;
        const rowTop = visualRow * state.rowHeight;
        const rowBottom = rowTop + state.rowHeight;
        if (rowTop < container.scrollTop) {
            container.scrollTop = rowTop;
        } else if (rowBottom > container.scrollTop + container.clientHeight) {
            container.scrollTop = rowBottom - container.clientHeight;
        }
    }

    renderWindow(): void {
        const { container, state } = this.deps;
        const rowHeight = state.rowHeight;
        const scrollTop = container.scrollTop;
        const clientHeight = container.clientHeight;
        const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER);
        const endRow = Math.min(state.filteredIndexes.length - 1, Math.ceil((scrollTop + clientHeight) / rowHeight) + BUFFER);
        const needed = Math.max(0, endRow - startRow + 1);

        while (this.pool.length < needed) {
            this.pool.push(this.buildSlot());
        }

        let slot = 0;
        for (let v = startRow; v <= endRow; v++) {
            const actualIndex = state.filteredIndexes[v];
            if (actualIndex === undefined) { continue; }
            this.bindSlot(this.pool[slot], actualIndex, v);
            slot++;
        }

        // Hide unused slots
        for (let s = slot; s < this.pool.length; s++) {
            if (this.pool[s].boundIndex !== -1) {
                this.pool[s].boundIndex = -1;
                this.pool[s].root.style.display = 'none';
            }
        }

        this.deps.onCountsChanged();
        this.applySelection();
    }

    applySelection(): void {
        const { state, container } = this.deps;
        let activeDescendant: string | null = null;
        for (const slot of this.pool) {
            if (slot.boundIndex === -1) { continue; }
            const selected = slot.boundIndex === state.selectedIndex;
            slot.root.classList.toggle('active', selected);
            slot.root.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (selected) {
                activeDescendant = slot.root.id;
            }
        }
        if (activeDescendant) {
            container.setAttribute('aria-activedescendant', activeDescendant);
        } else {
            container.removeAttribute('aria-activedescendant');
        }
    }

    private buildSlot(): PooledRow {
        const root = document.createElement('div');
        root.id = 'log-row-' + nextRowDomId++;
        root.setAttribute('role', 'option');
        root.style.position = 'absolute';
        root.style.left = '0';
        root.style.right = '0';
        root.style.display = 'none';

        const row = document.createElement('div');
        row.className = 'log-row';

        const tsEl = document.createElement('span');
        tsEl.className = 'timestamp';
        const levelEl = document.createElement('span');
        levelEl.className = 'level-badge';
        const sourceEl = document.createElement('span');
        sourceEl.className = 'source';
        const msgEl = document.createElement('span');
        msgEl.className = 'message';

        row.appendChild(tsEl);
        row.appendChild(levelEl);
        row.appendChild(sourceEl);
        row.appendChild(msgEl);
        root.appendChild(row);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'row-copy-btn';
        copyBtn.textContent = '⧉ JSON';
        copyBtn.title = 'Copy raw JSON (press c on a selected row)';
        copyBtn.setAttribute('aria-label', 'Copy raw JSON of this log entry');
        root.appendChild(copyBtn);

        const pooled: PooledRow = { root, tsEl, levelEl, sourceEl, msgEl, boundIndex: -1 };
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pooled.boundIndex !== -1) {
                this.deps.onCopyRow(pooled.boundIndex, copyBtn);
            }
        });
        root.addEventListener('click', () => {
            if (pooled.boundIndex !== -1) {
                this.deps.onRowClick(pooled.boundIndex);
            }
        });

        this.spacer.appendChild(root);
        return pooled;
    }

    private bindSlot(slot: PooledRow, actualIndex: number, visualRow: number): void {
        const { state } = this.deps;
        const log = state.logsData[actualIndex];
        const levelLower = (log.level || '').toLowerCase();
        const rebound = slot.boundIndex !== actualIndex;

        slot.boundIndex = actualIndex;
        slot.root.style.display = 'block';
        slot.root.style.top = (visualRow * state.rowHeight) + 'px';
        slot.root.style.height = state.rowHeight + 'px';

        if (rebound) {
            slot.root.className = 'log-item ' + levelLower;
            slot.root.setAttribute('data-index', String(actualIndex));

            const rawTs = log.timestamp;
            slot.tsEl.textContent = rawTs ? formatClock(rawTs) : '';
            slot.tsEl.title = rawTs ? formatTimestamp(rawTs) : '';

            const level = (log.level || '').toUpperCase();
            slot.levelEl.textContent = level;
            slot.levelEl.className = 'level-badge level-' + levelLower;

            const source = log.source || '';
            slot.sourceEl.textContent = source;
            slot.sourceEl.title = source;

            slot.msgEl.textContent = String(log.message || '');

            slot.root.setAttribute('aria-label', `${level} ${source} ${String(log.message || '')}`);

            if (actualIndex === this.animateIndex) {
                this.animateIndex = -1;
                slot.root.classList.add('row-enter');
                setTimeout(() => slot.root.classList.remove('row-enter'), 200);
            }
        }
    }
}

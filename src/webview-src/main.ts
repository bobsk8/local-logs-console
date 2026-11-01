import { ExtensionToWebviewMessage } from '../shared/protocol';
import { LogEntry } from '../models/logEntry';
import { post, getPersistedState, setPersistedState } from './vscodeApi';
import { createInitialState, defaultLevels, ROW_HEIGHTS, LEVELS, Density } from './state';
import { matchesBaseFilter, matchesFilter, fieldFilterToken } from './lib/filter';
import { LogModel } from './lib/logModel';
import { parseQuery, ParsedQuery } from '../shared/search';
import { VirtualList } from './virtualList';
import { Histogram } from './histogram';
import { DetailPanel } from './detailPanel';
import { EmptyStates } from './emptyStates';
import { initKeyboard } from './keyboard';

post({ command: 'ready' });

const container = document.getElementById('log-container');
const detailPanelEl = document.getElementById('detail-panel');
const jsonContent = document.getElementById('json-content');
const messageContent = document.getElementById('message-content');
const attributesTable = document.getElementById('attributes-table');
const closeBtn = document.getElementById('close-panel-btn');
const counterDisplay = document.getElementById('log-counter');
const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
const searchHint = document.getElementById('search-hint');
const searchHelp = document.getElementById('search-help');
const expandAllBtn = document.getElementById('json-expand-all');
const collapseAllBtn = document.getElementById('json-collapse-all');
const copyMessageBtn = document.getElementById('copy-message-btn');
const copyJsonBtn = document.getElementById('copy-json-btn');
const redactedBadge = document.getElementById('redacted-badge');
const dashboard = document.querySelector('.dashboard') as HTMLElement | null;
const resizer = document.getElementById('resizer');
const histogramEl = document.getElementById('log-histogram');
const exportBtn = document.getElementById('export-btn');
const clearBtn = document.getElementById('clear-btn');
const stopBtn = document.getElementById('stop-btn');
const densityBtn = document.getElementById('density-btn');
const ariaLive = document.getElementById('aria-live');

if (container && detailPanelEl && jsonContent && messageContent && attributesTable && counterDisplay && searchInput) {
    const state = createInitialState();
    let parsedQuery: ParsedQuery = parseQuery('');

    // ---- restore persisted UI state before the first render ----
    const savedState = getPersistedState();
    let pendingSelectedId: string | null = typeof savedState.selectedId === 'string' ? savedState.selectedId : null;

    if (savedState.activeLevels && typeof savedState.activeLevels === 'object') {
        state.activeLevels = Object.assign(defaultLevels(), savedState.activeLevels);
    }
    if (typeof savedState.search === 'string') {
        searchInput.value = savedState.search;
        parsedQuery = parseQuery(savedState.search);
    }
    if (typeof savedState.autoScroll === 'boolean') {
        state.autoScroll = savedState.autoScroll;
    }
    if (typeof savedState.detailWidth === 'string' && savedState.detailWidth) {
        detailPanelEl.style.width = savedState.detailWidth;
    }
    if (savedState.timeFilter && typeof savedState.timeFilter.start === 'number' && typeof savedState.timeFilter.end === 'number') {
        state.timeFilter = { start: savedState.timeFilter.start, end: savedState.timeFilter.end };
    }
    if (savedState.density === 'compact' || savedState.density === 'comfortable') {
        state.density = savedState.density;
        state.rowHeight = ROW_HEIGHTS[state.density];
    }
    syncFilterPills();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    function persistUiState(): void {
        if (persistTimer) { clearTimeout(persistTimer); }
        persistTimer = setTimeout(() => {
            persistTimer = null;
            const prev = getPersistedState();
            const selected = state.selectedIndex != null ? state.logsData[state.selectedIndex] : undefined;
            setPersistedState(Object.assign({}, prev, {
                selectedId: selected ? selected.id : null,
                activeLevels: state.activeLevels,
                search: searchInput!.value,
                scrollTop: container!.scrollTop,
                detailWidth: detailPanelEl!.style.width || undefined,
                autoScroll: state.autoScroll,
                timeFilter: state.timeFilter,
                density: state.density
            }));
        }, 150);
    }

    const matchesBase = (log: LogEntry) => matchesBaseFilter(log, parsedQuery, state.activeLevels);
    const matches = (log: LogEntry) => matchesFilter(log, parsedQuery, state.activeLevels, state.timeFilter);
    const model = new LogModel(state, matches);

    // ---- announcements for screen readers (throttled) ----
    let lastAnnounce = 0;
    function announce(text: string): void {
        if (!ariaLive) { return; }
        const now = Date.now();
        if (now - lastAnnounce < 1000) { return; }
        lastAnnounce = now;
        ariaLive.textContent = text;
    }

    // ---- feature modules ----
    const detailPanel = new DetailPanel({
        panel: detailPanelEl,
        resizer,
        dashboard,
        attributesTable,
        messageContent,
        jsonContent,
        closeBtn,
        expandAllBtn,
        collapseAllBtn,
        copyMessageBtn,
        copyJsonBtn,
        redactedBadge,
        onAttributeClick: (dottedKey, valueText) => {
            const token = fieldFilterToken(dottedKey, valueText);
            searchInput.value = (searchInput.value ? searchInput.value + ' ' : '') + token;
            applySearch();
            persistUiState();
        },
        onClose: () => {
            state.selectedIndex = null;
            list.applySelection();
            persistUiState();
        },
        onResizeEnd: () => {
            list.renderWindow();
            persistUiState();
        }
    });

    function copyRowJson(idx: number, feedbackEl?: HTMLElement): void {
        const log = state.logsData[idx];
        if (!log) { return; }
        let text: string;
        try {
            text = JSON.stringify(log.raw, null, 2);
        } catch {
            text = String(log.message || '');
        }
        navigator.clipboard.writeText(text).then(() => {
            announce('Raw JSON copied to clipboard');
            if (feedbackEl) {
                const original = feedbackEl.textContent;
                feedbackEl.textContent = '✓ Copied';
                setTimeout(() => { feedbackEl.textContent = original; }, 1200);
            }
        }).catch(() => {
            // clipboard unavailable — ignore
        });
    }

    const list = new VirtualList({
        container,
        state,
        onRowClick: (idx) => openDetail(idx),
        onCopyRow: (idx, feedbackEl) => copyRowJson(idx, feedbackEl)
    });

    const histogram = new Histogram({
        el: histogramEl,
        state,
        matchesBase,
        onTimeFilterChange: () => {
            updateFilteredIndexes();
            persistUiState();
        },
        labelEl: document.getElementById('time-filter-label'),
        labelTextEl: document.getElementById('time-filter-text'),
        labelClearBtn: document.getElementById('time-filter-clear')
    });

    // Paste modal elements and state
    const pasteModal = document.getElementById('paste-modal');
    const pasteTextarea = document.getElementById('paste-textarea') as HTMLTextAreaElement | null;
    const pasteLabelInput = document.getElementById('paste-label-input') as HTMLInputElement | null;
    const pasteImportBtn = document.getElementById('paste-import-btn');
    const pasteCancelBtn = document.getElementById('paste-cancel-btn');
    const emptyPasteBtn = document.getElementById('empty-paste-btn');
    const pasteBtn = document.getElementById('paste-btn');

    let lastFocusedBeforeModal: HTMLElement | null = null;

    function getFocusableElements(container: HTMLElement): HTMLElement[] {
        const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        return Array.from(container.querySelectorAll(selector) as NodeListOf<HTMLElement>)
            .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
    }

    function trapFocus(e: KeyboardEvent, container: HTMLElement): void {
        if (e.key !== 'Tab') { return; }
        const focusable = getFocusableElements(container);
        if (focusable.length === 0) { return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            last.focus();
            e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
            first.focus();
            e.preventDefault();
        }
    }

    function openPasteModal(): void {
        if (!pasteModal) { return; }
        lastFocusedBeforeModal = document.activeElement as HTMLElement;
        pasteModal.hidden = false;
        if (pasteTextarea) { pasteTextarea.focus(); }
    }

    function closePasteModal(): void {
        if (pasteModal) { pasteModal.hidden = true; }
        if (pasteTextarea) { pasteTextarea.value = ''; }
        if (pasteLabelInput) { pasteLabelInput.value = ''; }
        if (lastFocusedBeforeModal) {
            lastFocusedBeforeModal.focus();
            lastFocusedBeforeModal = null;
        }
    }

    if (emptyPasteBtn) {
        emptyPasteBtn.addEventListener('click', openPasteModal);
    }

    if (pasteBtn) {
        pasteBtn.addEventListener('click', openPasteModal);
    }

    if (pasteImportBtn) {
        pasteImportBtn.addEventListener('click', () => {
            if (pasteTextarea && pasteTextarea.value.trim()) {
                const label = pasteLabelInput ? pasteLabelInput.value.trim() : '';
                post({ command: 'pasteLogs', text: pasteTextarea.value, label: label || undefined });
                closePasteModal();
            }
        });
    }

    if (pasteCancelBtn) {
        pasteCancelBtn.addEventListener('click', closePasteModal);
    }

    if (pasteModal) {
        pasteModal.addEventListener('click', (e) => {
            if (e.target === pasteModal) {
                closePasteModal();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !pasteModal.hidden) {
                closePasteModal();
                e.preventDefault();
            }
        });
        pasteModal.addEventListener('keydown', (e) => {
            if (!pasteModal.hidden) {
                trapFocus(e, pasteModal);
            }
        });
    }

    const emptyStates = new EmptyStates({
        loadingEl: document.getElementById('loading-state'),
        emptyEl: document.getElementById('empty-state'),
        noResultsEl: document.getElementById('no-results-state'),
        onRunCommand: () => post({ command: 'runCommandRequest' }),
        onFollowFile: () => post({ command: 'followFileRequest' }),
        onClearFilters: () => resetFilters()
    });

    function openDetail(idx: number): void {
        detailPanel.open(state.logsData[idx]);
        state.selectedIndex = idx;
        list.applySelection();
        persistUiState();
    }

    function closeDetail(): void {
        detailPanel.close();
        state.selectedIndex = null;
        list.applySelection();
        persistUiState();
    }

    function resumeLive(): void {
        list.scrollToBottom();
        state.autoScroll = true;
        state.newCount = 0;
        persistUiState();
    }

    initKeyboard({
        state,
        searchInput,
        container,
        list,
        openDetail,
        closeDetail,
        isDetailOpen: () => detailPanel.isOpen(),
        resumeLive,
        clearSearch: () => {
            searchInput.value = '';
            applySearch();
            persistUiState();
        },
        copySelected: () => {
            if (state.selectedIndex != null) {
                copyRowJson(state.selectedIndex);
            }
        },
        persist: persistUiState
    });

    // ---- scrolling / live tail ----
    container.addEventListener('scroll', () => {
        list.renderWindow();
        state.autoScroll = list.isAtBottom();
        if (state.autoScroll) { state.newCount = 0; }
        persistUiState();
    });
    // The list viewport changes size when the detail panel opens/closes, the
    // histogram or time chip appears, or the window resizes — re-window and,
    // when following live, stay pinned to the bottom.
    new ResizeObserver(() => {
        const follow = state.autoScroll;
        list.renderWindow();
        if (follow) { list.scrollToBottom(); }
    }).observe(container);

    // ---- model updates ----
    function appendLogs(logs: LogEntry[]): void {
        if (logs.length === 0) { return; }
        const wasAtBottom = list.isAtBottom();
        const { removedVisible } = model.append(logs);
        // keep a scrolled-up viewport looking at the same rows after trimming
        if (!state.autoScroll && removedVisible > 0) {
            container!.scrollTop = Math.max(0, container!.scrollTop - removedVisible * state.rowHeight);
        }

        list.updateSpacer();
        if (wasAtBottom && state.autoScroll) {
            list.markLiveAppend(state.logsData.length - 1);
            list.scrollToBottom();
        } else {
            state.newCount += logs.length;
            announce(state.newCount + ' new logs');
        }
        list.renderWindow();
        updateCounterOnly();
        updateCountsDisplay();
        emptyStates.update(state);
        histogram.schedule();
    }

    function loadHistory(logs: LogEntry[], limit: number): void {
        const selectedId = state.selectedIndex != null ? state.logsData[state.selectedIndex]?.id : undefined;
        model.load(logs, limit);
        state.historyLoaded = true;
        if (selectedId) {
            const idx = model.indexOfId(selectedId);
            state.selectedIndex = idx === -1 ? null : idx;
        }
        list.updateSpacer();
        list.renderWindow();
        updateCounterOnly();
        updateCountsDisplay();
        emptyStates.update(state);
        histogram.schedule();

        if (!state.restored) {
            state.restored = true;
            // restore the selection by id — the history may have been trimmed since
            const selectedIdx = pendingSelectedId ? model.indexOfId(pendingSelectedId) : -1;
            pendingSelectedId = null;
            if (selectedIdx !== -1) {
                state.selectedIndex = selectedIdx;
                detailPanel.open(state.logsData[selectedIdx]);
                list.applySelection();
            } else {
                state.selectedIndex = null;
            }
            if (!state.autoScroll && typeof savedState.scrollTop === 'number') {
                const target = savedState.scrollTop;
                requestAnimationFrame(() => { container!.scrollTop = target; list.renderWindow(); });
                return;
            }
        }
        requestAnimationFrame(() => list.scrollToBottom());
    }

    // ---- messages from the extension ----
    window.addEventListener('message', event => {
        const message = event.data as ExtensionToWebviewMessage;
        if (message.command === 'addLogs') {
            appendLogs(message.logs);
        } else if (message.command === 'loadHistory') {
            loadHistory(message.logs, message.limit);
        } else if (message.command === 'sessions') {
            state.sessions = message.sessions;
            syncStopButton();
        } else if (message.command === 'requestVisibleIds') {
            post({ command: 'visibleIds', requestId: message.requestId, ids: model.visibleIds() });
        }
    });

    // ---- filtering ----
    function updateFilteredIndexes(): void {
        model.refilter();
        list.updateSpacer();
        if (state.autoScroll) { list.scrollToBottom(); }
        list.renderWindow();
        updateCounterOnly();
        emptyStates.update(state);
        histogram.schedule();
        announce(state.filteredIndexes.length + ' of ' + state.logsData.length + ' logs shown');
    }

    function applySearch(): void {
        parsedQuery = parseQuery(searchInput!.value);
        if (searchHint) {
            searchHint.textContent = parsedQuery.error || '';
            searchHint.hidden = !parsedQuery.error;
        }
        searchInput!.classList.toggle('invalid', !!parsedQuery.error);
        searchInput!.setAttribute('aria-invalid', parsedQuery.error ? 'true' : 'false');
        updateFilteredIndexes();
    }

    function resetFilters(): void {
        searchInput!.value = '';
        state.activeLevels = defaultLevels();
        state.timeFilter = null;
        syncFilterPills();
        applySearch();
        histogram.render();
        persistUiState();
    }

    function syncFilterPills(): void {
        document.querySelectorAll('.filter-badge').forEach(badge => {
            const level = badge.getAttribute('data-level') || '';
            const active = !!state.activeLevels[level];
            badge.classList.toggle('active', active);
            badge.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    // ---- toolbar widgets ----
    function updateCounterOnly(): void {
        counterDisplay!.textContent = state.filteredIndexes.length + ' / ' + state.totalLogsReceived;
        counterDisplay!.title = state.filteredIndexes.length + ' visible of ' + state.totalLogsReceived + ' total logs';
    }

    function updateCountsDisplay(): void {
        for (const level of LEVELS) {
            const el = document.getElementById('count-' + level);
            if (el) { el.textContent = String(state.levelCounts[level]); }
        }
    }


    // Severity filter pills
    document.querySelectorAll('.filter-badge').forEach(badge => {
        badge.addEventListener('click', () => {
            const level = badge.getAttribute('data-level') || '';
            state.activeLevels[level] = !state.activeLevels[level];
            syncFilterPills();
            updateFilteredIndexes();
            persistUiState();
        });
    });

    // Debounced search
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
        if (searchTimer) { clearTimeout(searchTimer); }
        searchTimer = setTimeout(() => {
            searchTimer = null;
            applySearch();
            persistUiState();
        }, 150);
    });
    if (searchHelp) {
        searchInput.addEventListener('focus', () => { searchHelp.hidden = false; });
        searchInput.addEventListener('blur', () => { searchHelp.hidden = true; });
    }

    // ---- toolbar actions ----
    if (clearBtn) {
        const originalLabel = clearBtn.textContent;
        let armed = false;
        let armTimer: ReturnType<typeof setTimeout> | null = null;
        const btn = clearBtn; // capture for closures

        function disarm(): void {
            armed = false;
            if (armTimer) { clearTimeout(armTimer); armTimer = null; }
            btn.textContent = originalLabel;
            btn.classList.remove('confirm-armed');
        }

        document.addEventListener('click', (e) => {
            if (armed && e.target !== btn) { disarm(); }
        }, true);

        btn.addEventListener('click', (e) => {
            if (!armed) {
                armed = true;
                btn.textContent = 'Confirm?';
                btn.classList.add('confirm-armed');
                armTimer = setTimeout(disarm, 2000);
                e.stopPropagation();
                return;
            }
            disarm();
            // Clear the logs, not the user's query: search and level pills
            // stay. The time window pointed at the cleared data, so it goes.
            model.clear();
            list.clear();
            detailPanel.close();
            state.autoScroll = true;
            state.newCount = 0;
            state.timeFilter = null;
            histogram.clear();
            updateCounterOnly();
            updateCountsDisplay();
            emptyStates.update(state);
            persistUiState();
            post({ command: 'clearLogs' });
        });
    }

    // Stop only makes sense while something runs
    function syncStopButton(): void {
        if (!stopBtn) { return; }
        const running = state.sessions.filter(s => s.status === 'running').length;
        (stopBtn as HTMLButtonElement).disabled = running === 0;
        stopBtn.title = running === 0 ? 'No capture is running' : `Stop ${running} running capture${running === 1 ? '' : 's'}`;
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            post({ command: 'stopAll' });
        });
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            post({ command: 'exportRequest' });
        });
    }

    function syncDensityBtn(): void {
        if (!densityBtn) { return; }
        densityBtn.setAttribute('aria-pressed', state.density === 'compact' ? 'true' : 'false');
        densityBtn.classList.toggle('active', state.density === 'compact');
    }
    if (densityBtn) {
        densityBtn.addEventListener('click', () => {
            // keep the same first visible row across the height change
            const firstRow = container.scrollTop / state.rowHeight;
            const next: Density = state.density === 'compact' ? 'comfortable' : 'compact';
            state.density = next;
            state.rowHeight = ROW_HEIGHTS[next];
            syncDensityBtn();
            list.applyRowHeight();
            list.updateSpacer();
            container.scrollTop = state.autoScroll ? container.scrollHeight : firstRow * state.rowHeight;
            list.renderWindow();
            persistUiState();
        });
    }

    // ---- initial paint ----
    syncStopButton();
    list.applyRowHeight();
    syncDensityBtn();
    updateCounterOnly();
    emptyStates.update(state);
}

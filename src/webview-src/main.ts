import { ExtensionToWebviewMessage, SessionSummary } from '../shared/protocol';
import { LogEntry } from '../models/logEntry';
import { post, getPersistedState, setPersistedState } from './vscodeApi';
import { createInitialState, defaultLevels, ROW_HEIGHTS, LEVELS, Density, TimeMode, TIME_MODES } from './state';
import { matchesBaseFilter, matchesFilter, fieldFilterToken, similarMessageQuery, extractViewFlags, ViewFilterExtras } from './lib/filter';
import { LogModel } from './lib/logModel';
import { FieldIndex, suggest, Suggestion } from './lib/suggest';
import { parseQuery, ParsedQuery } from '../shared/search';
import { VirtualList } from './virtualList';
import { Histogram } from './histogram';
import { DetailPanel, DetailTab, ContextView } from './detailPanel';
import { EmptyStates } from './emptyStates';
import { initKeyboard } from './keyboard';
import { codicon } from './highlight';

post({ command: 'ready' });

const container = document.getElementById('log-container');
const detailPanelEl = document.getElementById('detail-panel');
const jsonContent = document.getElementById('json-content');
const messageContent = document.getElementById('message-content');
const attributesTable = document.getElementById('attributes-table');
const counterDisplay = document.getElementById('log-counter');
const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
const searchHint = document.getElementById('search-hint');
const searchHelp = document.getElementById('search-help');
const suggestList = document.getElementById('suggest-list');
const searchClearBtn = document.getElementById('search-clear') as HTMLButtonElement | null;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement | null;
const dashboard = document.querySelector('.dashboard') as HTMLElement | null;
const histogramEl = document.getElementById('log-histogram');
const clearBtn = document.getElementById('clear-btn');
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement | null;
const densityBtn = document.getElementById('density-btn');
const liveBtn = document.getElementById('live-btn');
const liveText = document.getElementById('live-text');
const newLogsBtn = document.getElementById('new-logs-btn');
const newLogsText = document.getElementById('new-logs-text');
const sessionBar = document.getElementById('session-bar');
const timeColBtn = document.getElementById('time-col-btn');
const menuBtn = document.getElementById('menu-btn');
const menu = document.getElementById('main-menu');
const ariaLive = document.getElementById('aria-live');

const MAX_BOOKMARKS = 1000;
/** Entries scanned on each side of the opened line for the Context tab. */
const CONTEXT_SCAN = 5000;
const CONTEXT_ROWS = 15;
/** History entries fed to the autocomplete index on load (newest first). */
const INDEX_ON_LOAD = 5000;
const MAX_BACK = 30;

if (container && detailPanelEl && jsonContent && messageContent && attributesTable && counterDisplay && searchInput) {
    const state = createInitialState();
    let parsedQuery: ParsedQuery = parseQuery('');
    let highlights: string[] = [];
    const fieldIndex = new FieldIndex();

    // ---- restore persisted UI state before the first render ----
    const savedState = getPersistedState();
    let pendingSelectedId: string | null = typeof savedState.selectedId === 'string' ? savedState.selectedId : null;

    if (savedState.activeLevels && typeof savedState.activeLevels === 'object') {
        state.activeLevels = Object.assign(defaultLevels(), savedState.activeLevels);
    }
    if (typeof savedState.search === 'string') {
        searchInput.value = savedState.search;
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
    if (savedState.timeMode && TIME_MODES.includes(savedState.timeMode)) {
        state.timeMode = savedState.timeMode;
    }
    if (Array.isArray(savedState.bookmarks)) {
        state.bookmarks = new Set(savedState.bookmarks.filter(id => typeof id === 'string').slice(-MAX_BOOKMARKS));
    }
    if (Array.isArray(savedState.sessionFilter)) {
        state.sessionFilter = new Set(savedState.sessionFilter.filter(id => typeof id === 'string'));
    }
    const initialTab: DetailTab = savedState.detailTab === 'context' || savedState.detailTab === 'json' ? savedState.detailTab : 'overview';
    parseSearch();
    if (searchClearBtn) { searchClearBtn.hidden = searchInput.value.length === 0; }
    syncFilterPills();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let detailTab: DetailTab = initialTab;
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
                density: state.density,
                timeMode: state.timeMode,
                bookmarks: [...state.bookmarks],
                sessionFilter: [...state.sessionFilter],
                detailTab
            }));
        }, 150);
    }

    const extras = (): ViewFilterExtras => ({
        sessions: state.sessionFilter,
        bookmarks: state.bookmarkOnly ? state.bookmarks : null
    });
    const matchesBase = (log: LogEntry) => matchesBaseFilter(log, parsedQuery, state.activeLevels, extras());
    const matches = (log: LogEntry) => matchesFilter(log, parsedQuery, state.activeLevels, state.timeFilter, extras());
    const model = new LogModel(state, matches);

    // ---- announcements for screen readers (throttled) ----
    let lastAnnounce = 0;
    function announce(text: string, force = false): void {
        if (!ariaLive) { return; }
        const now = Date.now();
        if (!force && now - lastAnnounce < 1000) { return; }
        lastAnnounce = now;
        ariaLive.textContent = text;
    }

    // ---- feature modules ----
    const detailPanel = new DetailPanel({
        panel: detailPanelEl,
        resizer: document.getElementById('resizer'),
        dashboard,
        attributesTable,
        messageContent,
        jsonContent,
        closeBtn: document.getElementById('close-panel-btn'),
        expandAllBtn: document.getElementById('json-expand-all'),
        collapseAllBtn: document.getElementById('json-collapse-all'),
        copyMessageBtn: document.getElementById('copy-message-btn'),
        similarMessageBtn: document.getElementById('similar-message-btn'),
        copyJsonBtn: document.getElementById('copy-json-btn'),
        redactedBadge: document.getElementById('redacted-badge'),
        bookmarkBtn: document.getElementById('bookmark-btn'),
        stackSection: document.getElementById('stack-section'),
        stackList: document.getElementById('stack-list'),
        stackCount: document.getElementById('stack-count'),
        contextList: document.getElementById('context-list'),
        contextTitle: document.getElementById('context-title'),
        correlationBox: document.getElementById('correlation-box'),
        initialTab,
        onAttributeClick: (dottedKey, valueText) => {
            const token = fieldFilterToken(dottedKey, valueText);
            drillDown((searchInput.value ? searchInput.value + ' ' : '') + token);
        },
        onSimilarMessage: (message) => {
            const query = similarMessageQuery(message);
            if (query) { drillDown(query); }
        },
        onClose: () => {
            state.selectedIndex = null;
            list.applySelection();
            container.focus();
            persistUiState();
        },
        onResizeEnd: () => {
            list.renderWindow();
            persistUiState();
        },
        onTabChange: (tab) => {
            detailTab = tab;
            persistUiState();
        },
        onOpenFrame: (frame, log) => {
            post({ command: 'openSource', file: frame.file, line: frame.line, column: frame.column, sessionId: log.sessionId });
        },
        getContext: contextFor,
        correlationCount: (id) => {
            let n = 0;
            for (const entry of state.logsData) {
                if (entry.correlationId === id) { n++; }
            }
            return n;
        },
        onContextClick: (index) => selectAndReveal(index),
        isBookmarked: (id) => state.bookmarks.has(id),
        onToggleBookmark: (log) => toggleBookmark(log.id)
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
            announce('Raw JSON copied to clipboard', true);
            if (feedbackEl) {
                feedbackEl.classList.add('copied');
                feedbackEl.title = 'Copied ✓';
                setTimeout(() => { feedbackEl.classList.remove('copied'); feedbackEl.title = 'Copy raw JSON (press c on a selected row)'; }, 1200);
            }
        }).catch(() => {
            // clipboard unavailable — ignore
        });
    }

    const list = new VirtualList({
        container,
        state,
        onRowClick: (idx) => openDetail(idx),
        onCopyRow: (idx, feedbackEl) => copyRowJson(idx, feedbackEl),
        getHighlights: () => highlights
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

    // ---- modals: paste + shortcut sheet ----
    let lastFocusedBeforeModal: HTMLElement | null = null;

    function getFocusableElements(root: HTMLElement): HTMLElement[] {
        const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        return Array.from(root.querySelectorAll(selector) as NodeListOf<HTMLElement>)
            .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
    }

    function trapFocus(e: KeyboardEvent, root: HTMLElement): void {
        if (e.key !== 'Tab') { return; }
        const focusable = getFocusableElements(root);
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

    function setupModal(modal: HTMLElement | null, onClose: () => void): { open: (focusEl?: HTMLElement | null) => void; close: () => void } {
        const close = () => {
            if (!modal || modal.hidden) { return; }
            modal.hidden = true;
            onClose();
            const back = lastFocusedBeforeModal;
            lastFocusedBeforeModal = null;
            (back ?? container!).focus();
        };
        if (modal) {
            modal.addEventListener('click', (e) => { if (e.target === modal) { close(); } });
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); return; }
                trapFocus(e, modal);
            });
        }
        return {
            open: (focusEl) => {
                if (!modal) { return; }
                lastFocusedBeforeModal = document.activeElement as HTMLElement;
                modal.hidden = false;
                (focusEl ?? getFocusableElements(modal)[0])?.focus();
            },
            close
        };
    }

    const pasteTextarea = document.getElementById('paste-textarea') as HTMLTextAreaElement | null;
    const pasteLabelInput = document.getElementById('paste-label-input') as HTMLInputElement | null;
    const pasteModal = setupModal(document.getElementById('paste-modal'), () => {
        if (pasteTextarea) { pasteTextarea.value = ''; }
        if (pasteLabelInput) { pasteLabelInput.value = ''; }
    });
    const openPasteModal = () => pasteModal.open(pasteTextarea);
    document.getElementById('empty-paste-btn')?.addEventListener('click', openPasteModal);
    document.getElementById('paste-cancel-btn')?.addEventListener('click', pasteModal.close);
    document.getElementById('paste-import-btn')?.addEventListener('click', () => {
        if (pasteTextarea && pasteTextarea.value.trim()) {
            const label = pasteLabelInput ? pasteLabelInput.value.trim() : '';
            post({ command: 'pasteLogs', text: pasteTextarea.value, label: label || undefined });
            pasteModal.close();
        }
    });

    const shortcutsModal = setupModal(document.getElementById('shortcuts-modal'), () => { /* nothing to reset */ });
    document.getElementById('shortcuts-close-btn')?.addEventListener('click', shortcutsModal.close);

    const emptyStates = new EmptyStates({
        loadingEl: document.getElementById('loading-state'),
        emptyEl: document.getElementById('empty-state'),
        noResultsEl: document.getElementById('no-results-state'),
        onRunCommand: () => post({ command: 'runCommandRequest' }),
        onFollowFile: () => post({ command: 'followFileRequest' }),
        onClearFilters: () => resetFilters()
    });

    // ---- selection / detail ----
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
        container!.focus();
        persistUiState();
    }

    /** Visual row of a logsData index, or -1 when it is filtered out (binary search). */
    function visualRowOf(index: number): number {
        const f = state.filteredIndexes;
        let lo = 0;
        let hi = f.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (f[mid] === index) { return mid; }
            if (f[mid] < index) { lo = mid + 1; } else { hi = mid - 1; }
        }
        return -1;
    }

    /** Selects an entry, scrolls it to the middle (pausing live follow) and shows its details. */
    function selectAndReveal(index: number): void {
        const row = visualRowOf(index);
        if (row !== -1) {
            state.autoScroll = false;
            list.center(row);
            list.renderWindow();
        }
        openDetail(index);
        updateLiveUi();
    }

    // ---- back navigation: filters applied from the detail panel can be undone ----
    interface ViewSnapshot {
        search: string;
        activeLevels: Record<string, boolean>;
        timeFilter: { start: number; end: number } | null;
        sessionFilter: string[];
        selectedId: string | null;
        scrollTop: number;
        autoScroll: boolean;
    }
    const backStack: ViewSnapshot[] = [];

    function syncBackBtn(): void {
        if (backBtn) { backBtn.hidden = backStack.length === 0; }
    }

    /** Applies a query from the detail panel, remembering the current view for Back. */
    function drillDown(query: string): void {
        const selected = state.selectedIndex != null ? state.logsData[state.selectedIndex] : undefined;
        backStack.push({
            search: searchInput!.value,
            activeLevels: { ...state.activeLevels },
            timeFilter: state.timeFilter ? { ...state.timeFilter } : null,
            sessionFilter: [...state.sessionFilter],
            selectedId: selected ? selected.id : null,
            scrollTop: container!.scrollTop,
            autoScroll: state.autoScroll
        });
        if (backStack.length > MAX_BACK) { backStack.shift(); }
        syncBackBtn();
        searchInput!.value = query;
        applySearch();
        // stay on the line you came from when it still matches
        if (state.selectedIndex != null && visualRowOf(state.selectedIndex) !== -1) {
            selectAndReveal(state.selectedIndex);
        }
        persistUiState();
    }

    /** Restores the view (filters, selected line, scroll) from before the last drill-down. */
    function goBack(): void {
        const snap = backStack.pop();
        if (!snap) { return; }
        syncBackBtn();
        searchInput!.value = snap.search;
        state.activeLevels = { ...snap.activeLevels };
        state.timeFilter = snap.timeFilter;
        state.sessionFilter = new Set(snap.sessionFilter);
        syncFilterPills();
        renderSessions();
        applySearch();
        histogram.render();
        const idx = snap.selectedId ? model.indexOfId(snap.selectedId) : -1;
        if (idx !== -1 && visualRowOf(idx) !== -1) {
            selectAndReveal(idx);
        } else if (snap.autoScroll) {
            resumeLive();
        } else {
            container!.scrollTop = snap.scrollTop;
            list.renderWindow();
        }
        persistUiState();
    }

    backBtn?.addEventListener('click', goBack);
    // the mouse "back" button
    document.addEventListener('mouseup', (e) => {
        if (e.button === 3 && backStack.length > 0) {
            e.preventDefault();
            goBack();
        }
    });

    function contextFor(log: LogEntry): ContextView | null {
        const anchor = model.indexOfId(log.id);
        if (anchor === -1) { return null; }
        const sameStream = (e: LogEntry) => log.sessionId ? e.sessionId === log.sessionId : e.source === log.source;
        const before: number[] = [];
        for (let i = anchor - 1; i >= 0 && anchor - i <= CONTEXT_SCAN && before.length < CONTEXT_ROWS; i--) {
            if (sameStream(state.logsData[i])) { before.push(i); }
        }
        const after: number[] = [];
        for (let i = anchor + 1; i < state.logsData.length && i - anchor <= CONTEXT_SCAN && after.length < CONTEXT_ROWS; i++) {
            if (sameStream(state.logsData[i])) { after.push(i); }
        }
        const indexes = [...before.reverse(), anchor, ...after];
        const session = state.sessions.find(s => s.id === log.sessionId);
        return {
            rows: indexes.map(index => ({ index, entry: state.logsData[index] })),
            anchorIndex: anchor,
            scope: session ? session.label : (log.source || 'same source')
        };
    }

    // ---- live follow ----
    function updateLiveUi(): void {
        if (liveBtn) {
            liveBtn.classList.toggle('live', state.autoScroll);
            liveBtn.classList.toggle('paused', !state.autoScroll);
            liveBtn.setAttribute('aria-pressed', state.autoScroll ? 'true' : 'false');
            liveBtn.title = state.autoScroll ? 'Following new logs — click (or Space) to pause' : 'Paused — click (or Space) to jump to the newest logs';
        }
        if (liveText) { liveText.textContent = state.autoScroll ? 'Live' : 'Paused'; }
        if (newLogsBtn) {
            const show = !state.autoScroll && state.newCount > 0;
            newLogsBtn.hidden = !show;
            if (show && newLogsText) {
                newLogsText.textContent = `${state.newCount.toLocaleString()} new`;
            }
        }
    }

    function resumeLive(): void {
        list.scrollToBottom();
        state.autoScroll = true;
        state.newCount = 0;
        updateLiveUi();
        persistUiState();
    }

    function pauseLive(): void {
        state.autoScroll = false;
        updateLiveUi();
        persistUiState();
    }

    liveBtn?.addEventListener('click', () => { if (state.autoScroll) { pauseLive(); } else { resumeLive(); } });
    newLogsBtn?.addEventListener('click', () => { resumeLive(); container.focus(); });

    // ---- bookmarks ----
    function toggleBookmark(id: string): void {
        if (state.bookmarks.has(id)) {
            state.bookmarks.delete(id);
            announce('Bookmark removed', true);
        } else {
            state.bookmarks.add(id);
            if (state.bookmarks.size > MAX_BOOKMARKS) {
                state.bookmarks.delete(state.bookmarks.values().next().value as string);
            }
            announce('Bookmarked', true);
        }
        list.invalidate();
        if (state.bookmarkOnly) {
            updateFilteredIndexes();
        } else {
            list.renderWindow();
        }
        detailPanel.syncBookmark();
        persistUiState();
    }

    // ---- errors ----
    function jumpToError(direction: 1 | -1): void {
        const f = state.filteredIndexes;
        if (f.length === 0) { return; }
        let pos = state.selectedIndex != null ? visualRowOf(state.selectedIndex) : -1;
        if (pos === -1) { pos = direction === 1 ? -1 : f.length; }
        for (let p = pos + direction; p >= 0 && p < f.length; p += direction) {
            if (state.logsData[f[p]].level === 'ERROR') {
                state.selectedIndex = f[p];
                state.autoScroll = false;
                list.center(p);
                list.renderWindow();
                if (detailPanel.isOpen()) { detailPanel.open(state.logsData[f[p]]); }
                updateLiveUi();
                persistUiState();
                return;
            }
        }
        announce(direction === 1 ? 'No later errors' : 'No earlier errors', true);
    }

    // ---- time column ----
    const TIME_LABELS: Record<TimeMode, string> = { clock: 'Time', delta: 'Δ Prev', relative: 'Since start' };
    function setTimeMode(mode: TimeMode): void {
        state.timeMode = mode;
        if (timeColBtn) {
            timeColBtn.textContent = TIME_LABELS[mode];
            timeColBtn.title = 'Time format: ' + (mode === 'clock' ? 'clock' : mode === 'delta' ? 'since the previous line' : 'since the first line') + ' — click or press t to switch';
        }
        menu?.querySelectorAll('[data-time-mode]').forEach(item => {
            item.setAttribute('aria-checked', item.getAttribute('data-time-mode') === mode ? 'true' : 'false');
        });
        list.invalidate();
        list.renderWindow();
        persistUiState();
    }
    function cycleTimeMode(): void {
        setTimeMode(TIME_MODES[(TIME_MODES.indexOf(state.timeMode) + 1) % TIME_MODES.length]);
        announce('Time column: ' + TIME_LABELS[state.timeMode], true);
    }
    timeColBtn?.addEventListener('click', cycleTimeMode);

    initKeyboard({
        state,
        searchInput,
        container,
        list,
        openDetail,
        closeDetail,
        isDetailOpen: () => detailPanel.isOpen(),
        resumeLive,
        toggleLive: () => { if (state.autoScroll) { pauseLive(); } else { resumeLive(); } },
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
        toggleBookmarkSelected: () => {
            const log = state.selectedIndex != null ? state.logsData[state.selectedIndex] : undefined;
            if (log) { toggleBookmark(log.id); }
        },
        jumpToError,
        cycleTimeMode,
        showShortcuts: () => shortcutsModal.open(document.getElementById('shortcuts-close-btn')),
        goBack,
        persist: persistUiState
    });

    // ---- scrolling / live tail ----
    container.addEventListener('scroll', () => {
        list.renderWindow();
        const wasLive = state.autoScroll;
        state.autoScroll = list.isAtBottom();
        if (state.autoScroll) { state.newCount = 0; }
        if (wasLive !== state.autoScroll || state.autoScroll) { updateLiveUi(); }
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
        const { dropped, removedVisible } = model.append(logs);
        for (const entry of logs) { fieldIndex.add(entry); }
        // keep a scrolled-up viewport looking at the same rows after trimming
        if (!state.autoScroll && removedVisible > 0) {
            container!.scrollTop = Math.max(0, container!.scrollTop - removedVisible * state.rowHeight);
        }
        if (dropped > 0 && state.timeMode === 'relative') { list.invalidate(); }

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
        updateLiveUi();
        emptyStates.update(state);
        histogram.schedule();
        detailPanel.markContextStale();
    }

    function loadHistory(logs: LogEntry[], limit: number): void {
        const selectedId = state.selectedIndex != null ? state.logsData[state.selectedIndex]?.id : undefined;
        model.load(logs, limit);
        state.historyLoaded = true;
        fieldIndex.clear();
        for (let i = Math.max(0, state.logsData.length - INDEX_ON_LOAD); i < state.logsData.length; i++) {
            fieldIndex.add(state.logsData[i]);
        }
        pruneBookmarks();
        if (selectedId) {
            const idx = model.indexOfId(selectedId);
            state.selectedIndex = idx === -1 ? null : idx;
        }
        list.invalidate();
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
                updateLiveUi();
                return;
            }
        }
        updateLiveUi();
        requestAnimationFrame(() => list.scrollToBottom());
    }

    /** Bookmarks of entries that left the history are dropped (ids are unique per run). */
    function pruneBookmarks(): void {
        if (state.bookmarks.size === 0) { return; }
        for (const id of [...state.bookmarks]) {
            if (model.indexOfId(id) === -1) { state.bookmarks.delete(id); }
        }
    }

    // ---- capture sessions ----
    let sessionLabels = new Map<string, string>();
    function onSessions(sessions: SessionSummary[]): void {
        // a restarted capture gets a new id — carry its chip filter over
        const present = new Set(sessions.map(s => s.id));
        let filterChanged = false;
        for (const id of [...state.sessionFilter]) {
            if (present.has(id)) { continue; }
            state.sessionFilter.delete(id);
            filterChanged = true;
            const label = sessionLabels.get(id);
            const successor = label !== undefined ? sessions.find(s => s.label === label && !sessionLabels.has(s.id)) : undefined;
            if (successor) { state.sessionFilter.add(successor.id); }
        }
        sessionLabels = new Map(sessions.map(s => [s.id, s.label]));
        state.sessions = sessions;
        renderSessions();
        syncStopButton();
        if (filterChanged) {
            updateFilteredIndexes();
            persistUiState();
        }
    }

    function describeSession(s: SessionSummary): { text: string; failed: boolean } {
        if (s.status === 'running') { return { text: '', failed: false }; }
        if (s.status === 'stopped') { return { text: 'stopped', failed: false }; }
        if (typeof s.exitCode === 'number' && s.exitCode !== 0) { return { text: `exit ${s.exitCode}`, failed: true }; }
        return { text: typeof s.exitCode === 'number' ? 'exit 0' : 'ended', failed: false };
    }

    function renderSessions(): void {
        if (!sessionBar) { return; }
        sessionBar.textContent = '';
        sessionBar.hidden = state.sessions.length === 0;
        const filtering = state.sessionFilter.size > 0;
        for (const s of state.sessions) {
            const { text, failed } = describeSession(s);
            const chip = document.createElement('div');
            chip.className = 'session-chip' + (s.status === 'running' ? ' running' : '') + (failed ? ' failed' : '');
            const selected = state.sessionFilter.has(s.id);
            chip.classList.toggle('selected', selected);
            chip.classList.toggle('filtered-out', filtering && !selected);

            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'session-main';
            main.setAttribute('aria-pressed', selected ? 'true' : 'false');
            main.title = `${s.label}\n${s.status === 'running' ? 'Running' : text}\nClick to show only this capture (again to show all)`;
            const dot = document.createElement('span');
            dot.className = 'session-dot';
            dot.setAttribute('aria-hidden', 'true');
            const kind = codicon(s.kind === 'file' ? 'file' : s.kind === 'debug' ? 'debug-alt' : 'terminal');
            kind.classList.add('session-kind');
            const label = document.createElement('span');
            label.className = 'session-label';
            label.textContent = s.label;
            main.append(dot, kind, label);
            if (text) {
                const status = document.createElement('span');
                status.className = 'session-status';
                status.textContent = text;
                main.appendChild(status);
            }
            main.addEventListener('click', () => {
                if (state.sessionFilter.has(s.id)) {
                    state.sessionFilter.delete(s.id);
                } else {
                    state.sessionFilter.add(s.id);
                }
                renderSessions();
                updateFilteredIndexes();
                persistUiState();
            });
            chip.appendChild(main);

            const action = (icon: string, title: string, onClick: () => void) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'session-action';
                btn.title = title;
                btn.setAttribute('aria-label', `${title}: ${s.label}`);
                btn.appendChild(codicon(icon));
                btn.addEventListener('click', onClick);
                chip.appendChild(btn);
            };
            action('debug-restart', s.status === 'running' ? 'Restart' : 'Run again', () => post({ command: 'restartSession', id: s.id }));
            if (s.status === 'running') {
                action('debug-stop', 'Stop', () => post({ command: 'stopSession', id: s.id }));
            }
            sessionBar.appendChild(chip);
        }
    }

    // ---- messages from the extension ----
    window.addEventListener('message', event => {
        const message = event.data as ExtensionToWebviewMessage;
        if (message.command === 'addLogs') {
            appendLogs(message.logs);
        } else if (message.command === 'loadHistory') {
            loadHistory(message.logs, message.limit);
        } else if (message.command === 'sessions') {
            onSessions(message.sessions);
        } else if (message.command === 'requestVisibleIds') {
            post({ command: 'visibleIds', requestId: message.requestId, ids: model.visibleIds() });
        }
    });

    // ---- filtering ----
    function updateFilteredIndexes(): void {
        model.refilter();
        list.invalidate();
        list.updateSpacer();
        if (state.autoScroll) { list.scrollToBottom(); }
        list.renderWindow();
        updateCounterOnly();
        emptyStates.update(state);
        histogram.schedule();
        announce(state.filteredIndexes.length + ' of ' + state.logsData.length + ' logs shown');
    }

    /** Parses the search box: webview flags first, then the shared grammar. */
    function parseSearch(): void {
        const { query, bookmarked } = extractViewFlags(searchInput!.value);
        state.bookmarkOnly = bookmarked;
        parsedQuery = parseQuery(query);
        highlights = parsedQuery.clauses
            .filter(c => !c.negated && (c.type === 'term' || c.type === 'phrase' || (c.type === 'field' && c.field === 'message')))
            .map(c => c.value)
            .filter(v => v.length > 0);
    }

    function applySearch(): void {
        parseSearch();
        if (searchHint) {
            searchHint.textContent = parsedQuery.error || '';
            searchHint.hidden = !parsedQuery.error;
        }
        searchInput!.classList.toggle('invalid', !!parsedQuery.error);
        searchInput!.setAttribute('aria-invalid', parsedQuery.error ? 'true' : 'false');
        syncSearchClear();
        updateFilteredIndexes();
    }

    function syncSearchClear(): void {
        if (searchClearBtn) { searchClearBtn.hidden = searchInput!.value.length === 0; }
    }

    function resetFilters(): void {
        searchInput!.value = '';
        state.activeLevels = defaultLevels();
        state.timeFilter = null;
        state.sessionFilter.clear();
        syncFilterPills();
        renderSessions();
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
        const shown = state.filteredIndexes.length.toLocaleString();
        const total = state.logsData.length.toLocaleString();
        counterDisplay!.textContent = state.filteredIndexes.length === state.logsData.length ? total : `${shown} / ${total}`;
        counterDisplay!.title = `${shown} visible of ${total} loaded (${state.totalLogsReceived.toLocaleString()} received)`;
    }

    function updateCountsDisplay(): void {
        for (const level of LEVELS) {
            const el = document.getElementById('count-' + level);
            if (el) { el.textContent = String(state.levelCounts[level]); }
        }
        document.querySelector('.filter-badge.badge-error')?.classList.toggle('has-errors', state.levelCounts.error > 0);
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

    // ---- search box: debounced filtering + autocomplete ----
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleSearch(): void {
        if (searchTimer) { clearTimeout(searchTimer); }
        searchTimer = setTimeout(() => {
            searchTimer = null;
            applySearch();
            persistUiState();
        }, 150);
    }

    let suggestions: Suggestion[] = [];
    let activeSuggestion = -1;
    function renderSuggestions(): void {
        if (!suggestList) { return; }
        suggestList.textContent = '';
        const open = suggestions.length > 0;
        suggestList.hidden = !open;
        searchInput!.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (searchHelp && open) { searchHelp.hidden = true; }
        suggestions.forEach((s, i) => {
            const li = document.createElement('li');
            li.id = 'suggest-' + i;
            li.className = 'suggest-item';
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', i === activeSuggestion ? 'true' : 'false');
            const label = document.createElement('span');
            label.textContent = s.label;
            const kind = document.createElement('span');
            kind.className = 'suggest-kind';
            kind.textContent = s.kind;
            li.append(label, kind);
            // mousedown, not click: keep focus in the search box
            li.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggestion(i); });
            suggestList.appendChild(li);
        });
        if (activeSuggestion >= 0) {
            searchInput!.setAttribute('aria-activedescendant', 'suggest-' + activeSuggestion);
        } else {
            searchInput!.removeAttribute('aria-activedescendant');
        }
    }
    function refreshSuggestions(): void {
        const cursor = searchInput!.selectionStart ?? searchInput!.value.length;
        suggestions = suggest(searchInput!.value, cursor, fieldIndex);
        activeSuggestion = suggestions.length > 0 ? 0 : -1;
        renderSuggestions();
    }
    function closeSuggestions(): void {
        if (suggestions.length === 0) { return; }
        suggestions = [];
        activeSuggestion = -1;
        renderSuggestions();
    }
    function acceptSuggestion(i: number): void {
        const s = suggestions[i];
        if (!s) { return; }
        const value = searchInput!.value;
        const after = value.slice(s.to).replace(/^\S*/, ''); // replace the rest of the token too
        searchInput!.value = value.slice(0, s.from) + s.insert + after;
        const caret = s.from + s.insert.length;
        searchInput!.setSelectionRange(caret, caret);
        scheduleSearch();
        refreshSuggestions(); // `level:` → its values
    }

    searchInput.addEventListener('input', () => {
        syncSearchClear();
        scheduleSearch();
        refreshSuggestions();
    });
    searchInput.addEventListener('keydown', (e) => {
        if (suggestions.length === 0) {
            if (e.key === 'Enter') {
                // apply now instead of waiting for the debounce
                if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
                applySearch();
                persistUiState();
            }
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const n = suggestions.length;
            activeSuggestion = (activeSuggestion + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            renderSuggestions();
            e.preventDefault();
        } else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
            if (activeSuggestion >= 0) {
                acceptSuggestion(activeSuggestion);
                e.preventDefault();
            }
        } else if (e.key === 'Escape') {
            closeSuggestions();
            e.preventDefault();
            e.stopPropagation(); // first Esc closes the list, the second clears the search
        }
    });
    searchInput.addEventListener('focus', () => { if (searchHelp && suggestions.length === 0) { searchHelp.hidden = false; } });
    searchInput.addEventListener('blur', () => {
        if (searchHelp) { searchHelp.hidden = true; }
        closeSuggestions();
    });

    if (searchClearBtn) {
        // keep focus in the input so the blur handler doesn't flash the help popover
        searchClearBtn.addEventListener('mousedown', e => e.preventDefault());
        searchClearBtn.addEventListener('click', () => {
            if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
            searchInput.value = '';
            closeSuggestions();
            applySearch();
            persistUiState();
            searchInput.focus();
        });
    }

    // ---- clear (two-step) ----
    if (clearBtn) {
        let armed = false;
        let armTimer: ReturnType<typeof setTimeout> | null = null;
        const btn = clearBtn; // capture for closures

        const disarm = () => {
            armed = false;
            if (armTimer) { clearTimeout(armTimer); armTimer = null; }
            btn.classList.remove('confirm-armed');
            btn.title = 'Clear logs (click twice)';
        };

        document.addEventListener('click', (e) => {
            if (armed && !btn.contains(e.target as Node)) { disarm(); }
        }, true);

        btn.addEventListener('click', (e) => {
            if (!armed) {
                armed = true;
                btn.classList.add('confirm-armed');
                btn.title = 'Click again to clear every loaded log';
                armTimer = setTimeout(disarm, 2500);
                e.stopPropagation();
                return;
            }
            disarm();
            // Clear the logs, not the user's query: search and level pills
            // stay. The time window pointed at the cleared data, so it goes.
            model.clear();
            list.clear();
            detailPanel.close();
            fieldIndex.clear();
            state.bookmarks.clear();
            state.autoScroll = true;
            state.newCount = 0;
            state.timeFilter = null;
            histogram.clear();
            updateCounterOnly();
            updateCountsDisplay();
            updateLiveUi();
            emptyStates.update(state);
            persistUiState();
            post({ command: 'clearLogs' });
        });
    }

    // ---- overflow menu ----
    function menuItems(): HTMLElement[] {
        return menu ? Array.from(menu.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')) : [];
    }
    function openMenu(): void {
        if (!menu || !menuBtn) { return; }
        menu.hidden = false;
        menuBtn.setAttribute('aria-expanded', 'true');
        menuItems()[0]?.focus();
    }
    function closeMenu(focusButton = false): void {
        if (!menu || !menuBtn || menu.hidden) { return; }
        menu.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (focusButton) { menuBtn.focus(); }
    }
    menuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menu?.hidden) { openMenu(); } else { closeMenu(); }
    });
    document.addEventListener('click', (e) => {
        if (menu && !menu.hidden && !menu.contains(e.target as Node)) { closeMenu(); }
    });
    menu?.addEventListener('keydown', (e) => {
        const items = menuItems();
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const next = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            items[next]?.focus();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            closeMenu(true);
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Tab') {
            closeMenu();
        }
    });
    menu?.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.menu-item') as HTMLElement | null;
        if (!item) { return; }
        const mode = item.getAttribute('data-time-mode') as TimeMode | null;
        const action = item.getAttribute('data-action');
        closeMenu(true);
        if (mode) {
            setTimeMode(mode);
        } else if (item === densityBtn) {
            toggleDensity();
        } else if (action === 'paste') {
            openPasteModal();
        } else if (action === 'export') {
            post({ command: 'exportRequest' });
        } else if (action === 'stop') {
            post({ command: 'stopAll' });
        } else if (action === 'shortcuts') {
            shortcutsModal.open(document.getElementById('shortcuts-close-btn'));
        }
    });

    // Stop only makes sense while something runs
    function syncStopButton(): void {
        if (!stopBtn) { return; }
        const running = state.sessions.filter(s => s.status === 'running').length;
        stopBtn.disabled = running === 0;
        stopBtn.title = running === 0 ? 'No capture is running' : `Stop ${running} running capture${running === 1 ? '' : 's'}`;
    }

    function syncDensityBtn(): void {
        densityBtn?.setAttribute('aria-checked', state.density === 'compact' ? 'true' : 'false');
    }
    function toggleDensity(): void {
        // keep the same first visible row across the height change
        const firstRow = container!.scrollTop / state.rowHeight;
        const next: Density = state.density === 'compact' ? 'comfortable' : 'compact';
        state.density = next;
        state.rowHeight = ROW_HEIGHTS[next];
        syncDensityBtn();
        list.applyRowHeight();
        list.updateSpacer();
        list.invalidate();
        container!.scrollTop = state.autoScroll ? container!.scrollHeight : firstRow * state.rowHeight;
        list.renderWindow();
        persistUiState();
    }

    // ---- initial paint ----
    syncStopButton();
    list.applyRowHeight();
    syncDensityBtn();
    setTimeMode(state.timeMode);
    updateCounterOnly();
    updateLiveUi();
    emptyStates.update(state);
}

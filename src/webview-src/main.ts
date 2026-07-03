import { ExtensionToWebviewMessage } from '../shared/protocol';
import { LogEntry } from '../models/logEntry';
import { post, getPersistedState, setPersistedState } from './vscodeApi';
import { createInitialState, defaultLevels, ROW_HEIGHTS, LEVELS, Density } from './state';
import { matchesBaseFilter, matchesFilter } from './lib/filter';
import { parseQuery, ParsedQuery } from '../shared/search';
import { formatClockShort } from './lib/format';
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
const liveIndicator = document.getElementById('live-indicator');
const histogramEl = document.getElementById('log-histogram');
const timeChip = document.getElementById('time-chip');
const timeChipLabel = document.getElementById('time-chip-label');
const timeChipClear = document.getElementById('time-chip-clear');
const menuBtn = document.getElementById('menu-btn');
const menuDropdown = document.getElementById('menu-dropdown');
const menuClear = document.getElementById('menu-clear');
const menuStop = document.getElementById('menu-stop');
const menuDensity = document.getElementById('menu-density');
const ariaLive = document.getElementById('aria-live');

if (container && detailPanelEl && jsonContent && messageContent && attributesTable && counterDisplay && searchInput) {
    const state = createInitialState();
    let parsedQuery: ParsedQuery = parseQuery('');

    // ---- restore persisted UI state before the first render ----
    const savedState = getPersistedState();

    if (savedState.activeLevels && typeof savedState.activeLevels === 'object') {
        state.activeLevels = Object.assign(defaultLevels(), savedState.activeLevels);
    }
    if (typeof savedState.search === 'string') {
        searchInput.value = savedState.search;
        parsedQuery = parseQuery(savedState.search);
    }
    if (typeof savedState.selectedIndex === 'number') {
        state.selectedIndex = savedState.selectedIndex;
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
            setPersistedState(Object.assign({}, prev, {
                selectedIndex: state.selectedIndex,
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
            const value = /\s/.test(valueText) ? `"${valueText.replace(/"/g, '\\"')}"` : valueText;
            const token = `${dottedKey}:${value}`;
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
        onCopyRow: (idx, feedbackEl) => copyRowJson(idx, feedbackEl),
        onCountsChanged: updateCountsDisplay
    });

    const histogram = new Histogram({
        el: histogramEl,
        state,
        matchesBase,
        onTimeFilterChange: () => {
            updateFilteredIndexes();
            updateTimeChip();
            persistUiState();
        }
    });

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

    function resumeLive(): void {
        list.scrollToBottom();
        state.autoScroll = true;
        state.newCount = 0;
        updateLiveIndicator();
        persistUiState();
    }

    initKeyboard({
        state,
        searchInput,
        container,
        list,
        openDetail,
        closeDetail: () => {
            detailPanel.close();
            state.selectedIndex = null;
            list.applySelection();
            persistUiState();
        },
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
        updateLiveIndicator();
        persistUiState();
    });
    window.addEventListener('resize', () => list.renderWindow());

    // ---- messages from the extension ----
    window.addEventListener('message', event => {
        const message = event.data as ExtensionToWebviewMessage;
        if (message.command === 'addLog') {
            const wasAtBottom = list.isAtBottom();
            state.totalLogsReceived++;
            const idx = state.logsData.length;
            state.logsData.push(message.log);
            if (matches(message.log)) {
                state.filteredIndexes.push(idx);
            }
            list.updateSpacer();
            if (wasAtBottom && state.autoScroll) {
                list.markLiveAppend(idx);
            }
            list.renderWindow();
            if (wasAtBottom) {
                list.scrollToBottom();
            } else {
                state.newCount++;
                announce(state.newCount + ' new logs');
            }
            updateLiveIndicator();
            updateCounterOnly();
            emptyStates.update(state);
            histogram.schedule();
        } else if (message.command === 'loadHistory') {
            state.logsData = message.logs.slice();
            state.totalLogsReceived = state.logsData.length;
            state.historyLoaded = true;
            state.filteredIndexes = [];
            for (let i = 0; i < state.logsData.length; i++) {
                if (matches(state.logsData[i])) { state.filteredIndexes.push(i); }
            }
            list.updateSpacer();
            list.renderWindow();
            updateCounterOnly();
            updateTimeChip();
            emptyStates.update(state);
            histogram.schedule();

            if (!state.restored) {
                state.restored = true;
                // The ring buffer may have shifted; drop a now-invalid selection
                if (state.selectedIndex != null && state.selectedIndex < state.logsData.length) {
                    detailPanel.open(state.logsData[state.selectedIndex]);
                    list.applySelection();
                } else {
                    state.selectedIndex = null;
                }
                if (typeof savedState.scrollTop === 'number') {
                    const target = savedState.scrollTop;
                    setTimeout(() => { container.scrollTop = target; list.renderWindow(); }, 100);
                } else {
                    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
                }
            } else {
                setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
            }
            updateLiveIndicator();
        } else if (message.command === 'requestVisibleIds') {
            const ids = state.filteredIndexes.map(i => state.logsData[i].id);
            post({ command: 'visibleIds', requestId: message.requestId, ids });
        }
    });

    // ---- filtering ----
    function updateFilteredIndexes(): void {
        state.filteredIndexes = [];
        for (let i = 0; i < state.logsData.length; i++) {
            if (matches(state.logsData[i])) { state.filteredIndexes.push(i); }
        }
        list.updateSpacer();
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
        updateTimeChip();
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
    function updateLiveIndicator(): void {
        if (!liveIndicator) { return; }
        if (state.autoScroll) {
            liveIndicator.classList.add('live');
            liveIndicator.classList.remove('paused');
            liveIndicator.textContent = '● Live';
        } else {
            liveIndicator.classList.remove('live');
            liveIndicator.classList.add('paused');
            liveIndicator.textContent = state.newCount > 0 ? ('↓ Jump to latest · ' + state.newCount + ' new') : '↓ Jump to latest';
        }
    }

    function updateCounterOnly(): void {
        counterDisplay!.textContent = state.filteredIndexes.length + ' / ' + state.totalLogsReceived;
        counterDisplay!.title = state.filteredIndexes.length + ' visible of ' + state.totalLogsReceived + ' total logs';
    }

    function updateCountsDisplay(): void {
        const counts: Record<string, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
        for (let i = 0; i < state.logsData.length; i++) {
            const l = (state.logsData[i].level || '').toLowerCase();
            if (counts[l] !== undefined) { counts[l]++; }
        }
        for (const level of LEVELS) {
            const el = document.getElementById('count-' + level);
            if (el) { el.textContent = String(counts[level]); }
        }
    }

    function updateTimeChip(): void {
        if (!timeChip || !timeChipLabel) { return; }
        if (state.timeFilter) {
            timeChipLabel.textContent = '⏱ ' + formatClockShort(state.timeFilter.start) + '–' + formatClockShort(state.timeFilter.end);
            timeChip.hidden = false;
        } else {
            timeChip.hidden = true;
        }
    }

    if (timeChipClear) {
        timeChipClear.addEventListener('click', () => {
            state.timeFilter = null;
            updateFilteredIndexes();
            updateTimeChip();
            histogram.render();
            persistUiState();
        });
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

    if (liveIndicator) {
        liveIndicator.addEventListener('click', resumeLive);
    }

    // ---- overflow menu ----
    function setMenuOpen(open: boolean): void {
        if (!menuBtn || !menuDropdown) { return; }
        menuDropdown.hidden = !open;
        menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (menuBtn && menuDropdown) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setMenuOpen(menuDropdown.hidden);
        });
        document.addEventListener('click', (e) => {
            if (!menuDropdown.hidden && !menuDropdown.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menuDropdown.hidden) {
                setMenuOpen(false);
            }
        });
    }

    if (menuClear) {
        menuClear.addEventListener('click', () => {
            setMenuOpen(false);
            state.logsData = [];
            state.filteredIndexes = [];
            list.clear();
            state.totalLogsReceived = 0;
            detailPanel.close();
            state.selectedIndex = null;
            state.autoScroll = true;
            state.newCount = 0;
            state.timeFilter = null;
            searchInput.value = '';
            state.activeLevels = defaultLevels();
            syncFilterPills();
            parsedQuery = parseQuery('');
            histogram.clear();
            updateTimeChip();
            updateLiveIndicator();
            updateCounterOnly();
            updateCountsDisplay();
            emptyStates.update(state);
            persistUiState();
            post({ command: 'clearLogs' });
        });
    }

    if (menuStop) {
        menuStop.addEventListener('click', () => {
            setMenuOpen(false);
            post({ command: 'stopAll' });
        });
    }

    const menuExport = document.getElementById('menu-export');
    if (menuExport) {
        menuExport.addEventListener('click', () => {
            setMenuOpen(false);
            post({ command: 'exportRequest' });
        });
    }

    function syncDensityMenuItem(): void {
        if (!menuDensity) { return; }
        menuDensity.setAttribute('aria-checked', state.density === 'compact' ? 'true' : 'false');
        menuDensity.textContent = state.density === 'compact' ? 'Compact rows ✓' : 'Compact rows';
    }
    if (menuDensity) {
        menuDensity.addEventListener('click', () => {
            setMenuOpen(false);
            const next: Density = state.density === 'compact' ? 'comfortable' : 'compact';
            state.density = next;
            state.rowHeight = ROW_HEIGHTS[next];
            syncDensityMenuItem();
            list.applyRowHeight();
            list.updateSpacer();
            list.renderWindow();
            persistUiState();
        });
    }

    // ---- initial paint ----
    list.applyRowHeight();
    syncDensityMenuItem();
    updateLiveIndicator();
    updateCounterOnly();
    updateTimeChip();
    emptyStates.update(state);
}

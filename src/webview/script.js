(function () {
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ command: 'ready' });

    const container = document.getElementById('log-container');
    const detailPanel = document.getElementById('detail-panel');
    const jsonContent = document.getElementById('json-content');
    const messageContent = document.getElementById('message-content');
    const attributesTable = document.getElementById('attributes-table');
    const closeBtn = document.getElementById('close-panel-btn');
    const counterDisplay = document.getElementById('log-counter');
    const loadMoreBtn = document.getElementById('load-more-btn');
    const stopBtn = document.getElementById('stop-btn');
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-btn');
    const expandAllBtn = document.getElementById('json-expand-all');
    const collapseAllBtn = document.getElementById('json-collapse-all');
    const dashboard = document.querySelector('.dashboard');
    const resizer = document.getElementById('resizer');
    const liveIndicator = document.getElementById('live-indicator');
    const histogramEl = document.getElementById('log-histogram');

    const ROW_HEIGHT = 34;
    const BUFFER = 10;

    let logsData = []; // array of log objects
    let filteredIndexes = []; // indexes into logsData that match filters
    let rendered = new Map(); // index -> element
    let totalLogsReceived = 0;
    let isShowingHistory = false;
    let activeLevels = { error: false, warn: false, info: false, debug: false };
    let selectedIndex = null; // index into logsData of the selected row (stable across virtual recycling)
    let autoScroll = true;    // F5: whether the list follows new logs
    let newCount = 0;         // F5: logs arrived while paused
    let timeFilter = null;    // {start,end} ms — set by clicking a histogram bar
    let restored = false;     // F2c: whether we've restored persisted state on first history load

    // F2c: read any UI state persisted across reloads before the first render
    const savedState = (typeof vscode.getState === 'function' && vscode.getState()) || {};

    if (!container || !detailPanel || !jsonContent || !messageContent || !attributesTable || !counterDisplay || !loadMoreBtn || !searchInput || !clearBtn) {
        return;
    }

    // F2c: apply persisted filters/search/selection before the first loadHistory so matchesFilter uses them
    if (savedState.activeLevels && typeof savedState.activeLevels === 'object') {
        activeLevels = Object.assign({ error: false, warn: false, info: false, debug: false }, savedState.activeLevels);
        document.querySelectorAll('.filter-badge').forEach(badge => {
            const level = badge.getAttribute('data-level');
            badge.classList.toggle('active', !!activeLevels[level]);
        });
    }
    if (typeof savedState.search === 'string') {
        searchInput.value = savedState.search;
    }
    if (typeof savedState.selectedIndex === 'number') {
        selectedIndex = savedState.selectedIndex;
    }
    if (typeof savedState.autoScroll === 'boolean') {
        autoScroll = savedState.autoScroll;
    }
    if (typeof savedState.detailWidth === 'string' && savedState.detailWidth) {
        detailPanel.style.width = savedState.detailWidth;
    }

    let persistTimer = null;
    function persistUiState() {
        if (persistTimer) { clearTimeout(persistTimer); }
        persistTimer = setTimeout(() => {
            persistTimer = null;
            if (typeof vscode.setState !== 'function') { return; }
            const prev = (typeof vscode.getState === 'function' && vscode.getState()) || {};
            vscode.setState(Object.assign({}, prev, {
                selectedIndex,
                activeLevels,
                search: searchInput.value,
                scrollTop: container.scrollTop,
                detailWidth: detailPanel.style.width || undefined,
                autoScroll
            }));
        }, 150);
    }

    container.innerHTML = '';
    const spacer = document.createElement('div');
    spacer.style.position = 'relative';
    spacer.style.width = '100%';
    container.appendChild(spacer);

    container.addEventListener('scroll', onScroll);
    window.addEventListener('resize', renderWindow);

    function onScroll() {
        renderWindow();
        autoScroll = isAtBottom();
        if (autoScroll) { newCount = 0; }
        updateLiveIndicator();
        persistUiState();
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'addLog') {
            const wasAtBottom = isAtBottom();
            totalLogsReceived++;
            const idx = logsData.length;
            logsData.push(message.log);
            if (matchesFilter(message.log)) {
                filteredIndexes.push(idx);
            }
            updateSpacer();
            // Always render incoming logs. Smart auto-scroll (F5) handles the
            // "don't jump while I'm reading" case; the old isShowingHistory gate
            // silently dropped live rows and is no longer needed.
            renderWindow();
            if (wasAtBottom) {
                scrollToBottom();
            } else {
                newCount++;
            }
            updateLiveIndicator();
            updateCounterOnly();
            scheduleHistogram();
        } else if (message.command === 'loadHistory') {
            logsData = message.logs.slice();
            totalLogsReceived = logsData.length;
            filteredIndexes = [];
            for (let i = 0; i < logsData.length; i++) {
                if (matchesFilter(logsData[i])) filteredIndexes.push(i);
            }
            updateSpacer();
            renderWindow();
            updateCounterOnly();
            scheduleHistogram();

            if (!restored) {
                restored = true;
                // F2c: the ring buffer may have shifted; drop a now-invalid selection
                if (selectedIndex != null && selectedIndex < logsData.length) {
                    const log = logsData[selectedIndex];
                    renderAttributesTable(log.raw);
                    renderMessageBlock(log);
                    renderJsonTree(log.raw);
                    detailPanel.style.display = 'flex';
                    if (resizer) { resizer.style.display = 'block'; }
                    applySelection();
                } else {
                    selectedIndex = null;
                }
                if (typeof savedState.scrollTop === 'number') {
                    const target = savedState.scrollTop;
                    setTimeout(() => { container.scrollTop = target; renderWindow(); }, 100);
                } else {
                    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
                }
            } else {
                setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
            }
            updateLiveIndicator();
        }
    });

    // Level + text search. Drives the histogram (the volume timeline shows the
    // queried set, independent of the time-range click filter).
    function matchesBaseFilter(log) {
        const query = (searchInput?.value || '').toLowerCase().trim();
        const anyLevelActive = Object.values(activeLevels).some(v => v === true);
        const level = (log.level || '').toLowerCase();
        const content = (() => {
            try { return JSON.stringify(log.raw).toLowerCase(); } catch { return String(log.message || '').toLowerCase(); }
        })();
        const matchesText = !query || content.includes(query);
        const matchesLevel = !anyLevelActive || !!activeLevels[level];
        return matchesText && matchesLevel;
    }

    // Base filter + optional time-range window from a histogram click. Drives the list.
    function matchesFilter(log) {
        if (!matchesBaseFilter(log)) { return false; }
        if (timeFilter) {
            const t = new Date(log.timestamp).getTime();
            if (isNaN(t) || t < timeFilter.start || t >= timeFilter.end) { return false; }
        }
        return true;
    }

    function updateFilteredIndexes() {
        filteredIndexes = [];
        for (let i = 0; i < logsData.length; i++) {
            if (matchesFilter(logsData[i])) filteredIndexes.push(i);
        }
        updateSpacer();
        renderWindow(true);
        updateCounterOnly();
        scheduleHistogram();
    }

    function updateSpacer() {
        spacer.style.height = (filteredIndexes.length * ROW_HEIGHT) + 'px';
    }

    // F3.8: volume timeline. Debounced; reads logsData (not the virtualized DOM).
    const HIST_BUCKETS = 60;
    let histogramTimer = null;
    function scheduleHistogram() {
        if (!histogramEl || histogramTimer) { return; }
        histogramTimer = setTimeout(() => { histogramTimer = null; renderHistogram(); }, 200);
    }

    function renderHistogram() {
        if (!histogramEl) { return; }
        // Build from the base-filtered set (level + search) so the timeline reflects
        // the current query but does NOT collapse when a single bucket is clicked.
        const baseIdx = [];
        for (let i = 0; i < logsData.length; i++) {
            if (matchesBaseFilter(logsData[i])) { baseIdx.push(i); }
        }
        if (baseIdx.length === 0) { histogramEl.innerHTML = ''; return; }
        let min = Infinity, max = -Infinity;
        const times = {};
        for (const i of baseIdx) {
            const t = new Date(logsData[i].timestamp).getTime();
            times[i] = t;
            if (!isNaN(t)) { if (t < min) { min = t; } if (t > max) { max = t; } }
        }
        if (!isFinite(min) || !isFinite(max)) { histogramEl.innerHTML = ''; return; }
        const bucketMs = Math.max(1, max - min) / HIST_BUCKETS;
        const buckets = [];
        for (let b = 0; b < HIST_BUCKETS; b++) { buckets.push({ error: 0, warn: 0, info: 0, debug: 0, trace: 0, total: 0 }); }
        for (const i of baseIdx) {
            const t = times[i];
            if (isNaN(t)) { continue; }
            let bi = Math.floor((t - min) / bucketMs);
            if (bi >= HIST_BUCKETS) { bi = HIST_BUCKETS - 1; }
            if (bi < 0) { bi = 0; }
            const lvl = (logsData[i].level || '').toLowerCase();
            const bucket = buckets[bi];
            if (bucket[lvl] === undefined) { bucket.info++; } else { bucket[lvl]++; }
            bucket.total++;
        }
        let maxTotal = 1;
        for (const b of buckets) { if (b.total > maxTotal) { maxTotal = b.total; } }
        const order = ['error', 'warn', 'info', 'debug', 'trace'];
        const frag = document.createDocumentFragment();
        for (let b = 0; b < HIST_BUCKETS; b++) {
            const bucket = buckets[b];
            const bStart = min + b * bucketMs;
            const bEnd = (b === HIST_BUCKETS - 1) ? (max + 1) : (min + (b + 1) * bucketMs);

            const bar = document.createElement('div');
            bar.className = 'hist-bar';
            if (timeFilter && Math.abs(timeFilter.start - bStart) < 0.5) {
                bar.classList.add('selected');
            }

            const fill = document.createElement('div');
            fill.className = 'hist-fill';
            fill.style.height = ((bucket.total / maxTotal) * 100) + '%';
            for (const lvl of order) {
                if (bucket[lvl] > 0) {
                    const seg = document.createElement('div');
                    seg.className = 'hist-seg hist-' + lvl;
                    seg.style.flex = String(bucket[lvl]);
                    fill.appendChild(seg);
                }
            }
            bar.appendChild(fill);

            if (bucket.total > 0) {
                bar.classList.add('clickable');
                bar.title = bucket.total + ' logs · ' + formatClock(bStart) + '–' + formatClock(bEnd) + ' · click to filter';
                bar.addEventListener('click', () => {
                    if (timeFilter && Math.abs(timeFilter.start - bStart) < 0.5) {
                        timeFilter = null; // click the active bucket again to clear
                    } else {
                        timeFilter = { start: bStart, end: bEnd };
                    }
                    updateFilteredIndexes();
                    renderHistogram();
                    persistUiState();
                });
            }
            frag.appendChild(bar);
        }
        histogramEl.innerHTML = '';
        histogramEl.appendChild(frag);
    }

    function renderWindow(forceTop = false) {
        const scrollTop = container.scrollTop;
        const clientHeight = container.clientHeight;
        const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
        const endRow = Math.min(filteredIndexes.length - 1, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + BUFFER);
        const toRender = new Set();

        for (let v = startRow; v <= endRow; v++) {
            const actualIndex = filteredIndexes[v];
            if (actualIndex === undefined) continue;
            toRender.add(actualIndex);
            if (!rendered.has(actualIndex)) {
                const el = document.createElement('div');
                el.className = 'log-item ' + (logsData[actualIndex].level || '').toLowerCase();
                el.style.position = 'absolute';
                el.style.left = '0';
                el.style.right = '0';
                el.style.top = (v * ROW_HEIGHT) + 'px';
                el.style.height = ROW_HEIGHT + 'px';
                el.setAttribute('data-index', String(actualIndex));

                const level = (logsData[actualIndex].level || '').toUpperCase();
                const messageText = String(logsData[actualIndex].message || '');
                const rawTs = logsData[actualIndex].timestamp;
                const tsAbs = rawTs ? formatTimestamp(rawTs) : '';
                const tsClock = rawTs ? formatClock(rawTs) : '';
                const source = logsData[actualIndex].source || '';

                el.innerHTML = `<div class="log-row"><span class="timestamp" title="${escapeHtml(tsAbs)}">${escapeHtml(tsClock)}</span><span class="level-badge level-${level.toLowerCase()}">${escapeHtml(level)}</span><span class="source" title="${escapeHtml(source)}">${escapeHtml(source)}</span><span class="message">${escapeHtml(messageText)}</span></div>`;

                el.addEventListener('click', () => {
                    const idx = Number(el.getAttribute('data-index'));
                    if (!Number.isNaN(idx)) {
                        renderAttributesTable(logsData[idx].raw);
                        renderMessageBlock(logsData[idx]);
                        renderJsonTree(logsData[idx].raw);
                        detailPanel.style.display = 'flex';
                        if (resizer) { resizer.style.display = 'block'; }
                        selectedIndex = idx;
                        applySelection();
                        persistUiState();
                    }
                });

                spacer.appendChild(el);
                rendered.set(actualIndex, { el, v });
            } else {
                const record = rendered.get(actualIndex);
                if (record) record.el.style.top = (v * ROW_HEIGHT) + 'px';
            }
        }

        // update counts display
        updateCountsDisplay();

        // Remove non-needed elements
        for (const [idx, rec] of Array.from(rendered.entries())) {
            if (!toRender.has(idx)) {
                try { rec.el.remove(); } catch { }
                rendered.delete(idx);
            }
        }

        // F2b: reapply selection highlight to rows that (re)entered the window
        applySelection();
    }

    function applySelection() {
        rendered.forEach(rec => {
            const idx = Number(rec.el.getAttribute('data-index'));
            rec.el.classList.toggle('active', idx === selectedIndex);
        });
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (m) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
        });
    }

    function pad(n, width = 2) {
        const s = String(n);
        return s.length >= width ? s : new Array(width - s.length + 1).join('0') + s;
    }

    function formatTimestamp(input) {
        try {
            const d = new Date(input);
            if (isNaN(d.getTime())) return '';
            const Y = d.getFullYear();
            const M = pad(d.getMonth() + 1);
            const D = pad(d.getDate());
            const hh = pad(d.getHours());
            const mm = pad(d.getMinutes());
            const ss = pad(d.getSeconds());
            const ms = pad(d.getMilliseconds(), 3);
            return `${Y}-${M}-${D} ${hh}:${mm}:${ss}.${ms}`;
        } catch {
            return '';
        }
    }

    // Datadog-style event time: clock with milliseconds (HH:mm:ss.SSS).
    // Full date+time is shown on hover via the title attribute.
    function formatClock(input) {
        try {
            const d = new Date(input);
            if (isNaN(d.getTime())) { return String(input || ''); }
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch {
            return String(input || '');
        }
    }

    function formatRelative(input) {
        try {
            const d = new Date(input);
            if (isNaN(d.getTime())) { return String(input || ''); }
            const diff = Date.now() - d.getTime();
            if (diff < 0) { return formatTimestamp(input); }
            const s = Math.floor(diff / 1000);
            if (s < 5) { return 'just now'; }
            if (s < 60) { return s + 's ago'; }
            const m = Math.floor(s / 60);
            if (m < 60) { return m + 'm ago'; }
            const h = Math.floor(m / 60);
            if (h < 24) { return h + 'h ago'; }
            const days = Math.floor(h / 24);
            if (days < 7) { return days + 'd ago'; }
            return formatTimestamp(input);
        } catch {
            return String(input || '');
        }
    }

    function updateLiveIndicator() {
        if (!liveIndicator) { return; }
        if (autoScroll) {
            liveIndicator.classList.add('live');
            liveIndicator.classList.remove('paused');
            liveIndicator.textContent = '● Live';
        } else {
            liveIndicator.classList.remove('live');
            liveIndicator.classList.add('paused');
            liveIndicator.textContent = newCount > 0 ? ('↓ Jump to latest · ' + newCount + ' new') : '↓ Jump to latest';
        }
    }

    function isAtBottom() {
        return container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
    }

    function scrollToBottom() {
        container.scrollTop = container.scrollHeight;
    }

    function updateCounterOnly() {
        counterDisplay.textContent = filteredIndexes.length + " visible / " + totalLogsReceived + " total";
    }

    function updateCountsDisplay() {
        const counts = { error: 0, warn: 0, info: 0, debug: 0 };
        for (let i = 0; i < logsData.length; i++) {
            const l = (logsData[i].level || '').toLowerCase();
            if (counts[l] !== undefined) counts[l]++;
        }
        const elErr = document.getElementById('count-error');
        const elWarn = document.getElementById('count-warn');
        const elInfo = document.getElementById('count-info');
        const elDebug = document.getElementById('count-debug');
        if (elErr) elErr.textContent = `Error: ${counts.error}`;
        if (elWarn) elWarn.textContent = `Warn: ${counts.warn}`;
        if (elInfo) elInfo.textContent = `Info: ${counts.info}`;
        if (elDebug) elDebug.textContent = `Debug: ${counts.debug}`;
    }

    // Filters
    document.querySelectorAll('.filter-badge').forEach(badge => {
        badge.addEventListener('click', () => {
            const level = badge.getAttribute('data-level');
            activeLevels[level] = !activeLevels[level];
            badge.classList.toggle('active');
            updateFilteredIndexes();
            persistUiState();
        });
    });

    searchInput.addEventListener('input', () => {
        updateFilteredIndexes();
        persistUiState();
    });

    if (liveIndicator) {
        liveIndicator.addEventListener('click', () => {
            scrollToBottom();
            autoScroll = true;
            newCount = 0;
            updateLiveIndicator();
            persistUiState();
        });
    }

    clearBtn.addEventListener('click', () => {
        logsData = [];
        filteredIndexes = [];
        rendered.forEach(r => r.el.remove());
        rendered.clear();
        spacer.style.height = '0px';
        totalLogsReceived = 0;
        isShowingHistory = false;
        loadMoreBtn.style.display = 'none';
        detailPanel.style.display = 'none';
        searchInput.value = '';
        activeLevels = { error: false, warn: false, info: false, debug: false };
        document.querySelectorAll('.filter-badge').forEach(b => b.classList.remove('active'));
        selectedIndex = null;
        autoScroll = true;
        newCount = 0;
        timeFilter = null;
        if (resizer) { resizer.style.display = 'none'; }
        if (histogramEl) { histogramEl.innerHTML = ''; }
        updateLiveIndicator();
        updateCounterOnly();
        persistUiState();
        vscode.postMessage({ command: 'clearLogs' });
    });

    loadMoreBtn.addEventListener('click', () => {
        isShowingHistory = true;
        loadMoreBtn.style.display = 'none';
        vscode.postMessage({ command: 'loadMore' });
    });

    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopAll' });
        });
    }

    function renderAttributesTable(obj, prefix = '') {
        if (prefix === '') attributesTable.innerHTML = '';
        if (typeof obj !== 'object' || obj === null) {
            return;
        }

        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const val = obj[key];
                const currentKey = prefix ? prefix + '.' + key : key;
                if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                    renderAttributesTable(val, currentKey);
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
                    tdVal.addEventListener('click', () => {
                        searchInput.value = (searchInput.value ? searchInput.value + ' ' : '') + valText;
                        updateFilteredIndexes();
                        persistUiState();
                    });
                    tr.appendChild(tdKey);
                    tr.appendChild(tdVal);
                    attributesTable.appendChild(tr);
                }
            }
        }
    }

    function renderMessageBlock(logEntry) {
        const directMessage = logEntry && logEntry.message ? String(logEntry.message) : '';
        const rawMessage = logEntry && logEntry.raw && typeof logEntry.raw === 'object' && logEntry.raw.message
            ? String(logEntry.raw.message)
            : '';
        const finalMessage = directMessage || rawMessage || '(message not available)';
        messageContent.textContent = finalMessage;
    }

    function isExpandable(value) {
        return typeof value === 'object' && value !== null;
    }

    function formatPrimitive(value) {
        if (value === null) return { text: 'null', className: 'json-null' };
        if (typeof value === 'string') return { text: `"${value}"`, className: 'json-string' };
        if (typeof value === 'number') return { text: String(value), className: 'json-number' };
        if (typeof value === 'boolean') return { text: String(value), className: 'json-boolean' };
        return { text: String(value), className: 'json-unknown' };
    }

    function setNodeCollapsed(nodeEl, collapsed) {
        const toggle = nodeEl.querySelector(':scope > .json-line > .json-toggle');
        const children = nodeEl.querySelector(':scope > .json-children');
        if (!toggle || !children) return;

        toggle.textContent = collapsed ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        children.style.display = collapsed ? 'none' : 'block';
    }

    function createJsonNode(key, value, depth = 0) {
        const node = document.createElement('div');
        node.className = 'json-node';

        const line = document.createElement('div');
        line.className = 'json-line';
        line.style.paddingLeft = (depth * 16) + 'px';

        const keyEl = document.createElement('span');
        keyEl.className = 'json-key';
        keyEl.textContent = key;

        if (!isExpandable(value)) {
            const primitive = formatPrimitive(value);
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
        const size = isArray ? value.length : Object.keys(value).length;
        const typeHint = isArray ? `[${size}]` : `{${size}}`;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'json-toggle';

        const typeEl = document.createElement('span');
        typeEl.className = 'json-type';
        typeEl.textContent = ` ${typeHint}`;

        const children = document.createElement('div');
        children.className = 'json-children';

        const entries = isArray
            ? value.map((item, index) => [String(index), item])
            : Object.entries(value);

        for (const [childKey, childValue] of entries) {
            children.appendChild(createJsonNode(childKey, childValue, depth + 1));
        }

        const collapsedByDefault = false;

        const handleToggle = (ev) => {
            ev.stopPropagation();
            const currentlyExpanded = toggle.getAttribute('aria-expanded') === 'true';
            setNodeCollapsed(node, currentlyExpanded);
        };

        toggle.addEventListener('click', handleToggle);
        line.addEventListener('click', handleToggle);

        line.appendChild(toggle);
        line.appendChild(keyEl);
        line.appendChild(document.createTextNode(':'));
        line.appendChild(typeEl);
        node.appendChild(line);
        node.appendChild(children);

        setNodeCollapsed(node, collapsedByDefault);
        return node;
    }

    function renderJsonTree(payload) {
        jsonContent.innerHTML = '';

        let sanitizedPayload = payload;

        if (payload && typeof payload === 'object') {
            sanitizedPayload = JSON.parse(JSON.stringify(payload));

            delete sanitizedPayload.message;
        }

        if (!isExpandable(sanitizedPayload)) {
            const root = createJsonNode('value', sanitizedPayload, 0);
            jsonContent.appendChild(root);
            return;
        }

        const rootContainer = document.createElement('div');
        rootContainer.className = 'json-root';

        const entries = Array.isArray(sanitizedPayload)
            ? sanitizedPayload.map((item, index) => [String(index), item])
            : Object.entries(sanitizedPayload);

        for (const [childKey, childValue] of entries) {
            rootContainer.appendChild(
                createJsonNode(childKey, childValue, 0)
            );
        }

        jsonContent.appendChild(rootContainer);
    }

    function setAllTreeNodesCollapsed(collapsed) {
        jsonContent.querySelectorAll('.json-node').forEach(node => {
            const hasChildren = !!node.querySelector(':scope > .json-children');
            if (hasChildren) {
                setNodeCollapsed(node, collapsed);
            }
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            detailPanel.style.display = 'none';
            if (resizer) { resizer.style.display = 'none'; }
            selectedIndex = null;
            applySelection();
            persistUiState();
        });
    }

    // F4: drag the resizer to resize the detail panel
    if (resizer && dashboard) {
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
            detailPanel.style.width = w + 'px';
        });
        const endDrag = (e) => {
            if (!dragging) { return; }
            dragging = false;
            resizer.classList.remove('dragging');
            try { resizer.releasePointerCapture(e.pointerId); } catch { }
            renderWindow();
            persistUiState();
        };
        resizer.addEventListener('pointerup', endDrag);
        resizer.addEventListener('pointercancel', endDrag);
    }

    updateLiveIndicator();

    if (expandAllBtn) {
        expandAllBtn.addEventListener('click', () => setAllTreeNodesCollapsed(false));
    }

    if (collapseAllBtn) {
        collapseAllBtn.addEventListener('click', () => setAllTreeNodesCollapsed(true));
    }
})();

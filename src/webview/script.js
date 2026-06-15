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
    const truncateSelect = document.getElementById('truncate-select');
    const expandAllBtn = document.getElementById('json-expand-all');
    const collapseAllBtn = document.getElementById('json-collapse-all');

    const ROW_HEIGHT = 34;
    const BUFFER = 10;

    let logsData = []; // array of log objects
    let filteredIndexes = []; // indexes into logsData that match filters
    let rendered = new Map(); // index -> element
    let totalLogsReceived = 0;
    let isShowingHistory = false;
    let activeLevels = { error: false, warn: false, info: false, debug: false };
    let truncateLimit = parseInt(truncateSelect?.value || '2000', 10);

    if (!container || !detailPanel || !jsonContent || !messageContent || !attributesTable || !counterDisplay || !loadMoreBtn || !searchInput || !clearBtn) {
        return;
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
            if (!isShowingHistory) {
                renderWindow();
                if (wasAtBottom) scrollToBottom();
                updateCounterOnly();
            } else {
                updateCounterOnly();
            }
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
            setTimeout(() => { container.scrollTop = container.scrollHeight; }, 100);
        }
    });

    function matchesFilter(log) {
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

    function updateFilteredIndexes() {
        filteredIndexes = [];
        for (let i = 0; i < logsData.length; i++) {
            if (matchesFilter(logsData[i])) filteredIndexes.push(i);
        }
        updateSpacer();
        renderWindow(true);
        updateCounterOnly();
    }

    function updateSpacer() {
        spacer.style.height = (filteredIndexes.length * ROW_HEIGHT) + 'px';
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
                const displayMessage = truncateLimit > 0 && messageText.length > truncateLimit ? messageText.substring(0, truncateLimit) + '... (truncated)' : messageText;
                const ts = logsData[actualIndex].timestamp ? formatTimestamp(logsData[actualIndex].timestamp) : '';
                const source = logsData[actualIndex].source || '';

                el.innerHTML = `<div class="log-row"><span class="timestamp">${escapeHtml(ts)}</span><span class="level-badge level-${level.toLowerCase()}">[${level}]</span><span class="source">${escapeHtml(source)}</span><span class="message">${escapeHtml(displayMessage)}</span></div>`;

                el.addEventListener('click', () => {
                    const idx = Number(el.getAttribute('data-index'));
                    if (idx !== undefined) {
                        renderAttributesTable(logsData[idx].raw);
                        renderMessageBlock(logsData[idx]);
                        renderJsonTree(logsData[idx].raw);
                        detailPanel.style.display = 'flex';
                        // mark active styling
                        document.querySelectorAll('.log-item.active').forEach(n => n.classList.remove('active'));
                        el.classList.add('active');
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
                try { rec.el.remove(); } catch {}
                rendered.delete(idx);
            }
        }
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
        });
    });

    searchInput.addEventListener('input', () => {
        updateFilteredIndexes();
    });

    truncateSelect?.addEventListener('change', () => {
        truncateLimit = parseInt(truncateSelect.value, 10);
        renderWindow(true);
    });

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
        updateCounterOnly();
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
                    tdVal.className = 'attr-val';
                    tdVal.textContent = typeof val === 'object' ? JSON.stringify(val) : val;
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

        if (!isExpandable(payload)) {
            const root = createJsonNode('value', payload, 0);
            jsonContent.appendChild(root);
            return;
        }

        const rootContainer = document.createElement('div');
        rootContainer.className = 'json-root';

        const entries = Array.isArray(payload)
            ? payload.map((item, index) => [String(index), item])
            : Object.entries(payload);

        for (const [childKey, childValue] of entries) {
            rootContainer.appendChild(createJsonNode(childKey, childValue, 0));
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
            document.querySelectorAll('.log-item.active').forEach(n => n.classList.remove('active'));
        });
    }

    if (expandAllBtn) {
        expandAllBtn.addEventListener('click', () => setAllTreeNodesCollapsed(false));
    }

    if (collapseAllBtn) {
        collapseAllBtn.addEventListener('click', () => setAllTreeNodesCollapsed(true));
    }
})();

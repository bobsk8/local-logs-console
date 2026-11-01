import { UiState } from './state';
import { VirtualList } from './virtualList';

export interface KeyboardDeps {
    state: UiState;
    searchInput: HTMLInputElement;
    container: HTMLElement;
    list: VirtualList;
    openDetail: (index: number) => void;
    closeDetail: () => void;
    isDetailOpen: () => boolean;
    resumeLive: () => void;
    /** Space: pause following new logs, or resume. */
    toggleLive: () => void;
    clearSearch: () => void;
    /** Copy the selected entry's raw JSON to the clipboard. */
    copySelected: () => void;
    toggleBookmarkSelected: () => void;
    /** Select the next (1) / previous (-1) visible ERROR entry. */
    jumpToError: (direction: 1 | -1) => void;
    cycleTimeMode: () => void;
    showShortcuts: () => void;
    /** Backspace: undo the last filter applied from the detail panel. */
    goBack: () => void;
    persist: () => void;
}

/**
 * Global keyboard navigation (the `?` sheet in the dashboard lists them all):
 *   /  or Ctrl/Cmd+F   focus search        Esc (in search)  clear + leave search
 *   ↑ / ↓              move selection      Enter            open details
 *   Esc                close details       Home / End       first / last line
 *   Ctrl/Cmd+End       resume live tail    Space            pause / resume live
 *   e / Shift+E        next / prev error   b                bookmark
 *   c                  copy raw JSON       t                time column format
 *   ?                  shortcut sheet      Backspace        back to the previous filter
 */
export function initKeyboard(deps: KeyboardDeps): void {
    const { state, searchInput, container, list } = deps;

    document.addEventListener('keydown', (e) => {
        const target = e.target as HTMLElement | null;
        const inSearch = target === searchInput;

        if (inSearch) {
            if (e.key === 'Escape') {
                deps.clearSearch();
                searchInput.blur();
                container.focus();
                e.preventDefault();
            }
            return; // never hijack typing
        }

        // Never hijack typing in other fields (paste dialog, label input) or
        // keys aimed at interactive elements (buttons, pills, menu, tabs)
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' ||
            target.isContentEditable || target.closest?.('.menu-dropdown, .modal-overlay, .context-list'))) {
            return;
        }

        const plain = !e.ctrlKey && !e.metaKey && !e.altKey;

        // Focus search
        if ((e.key === '/' && plain) ||
            (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey)) {
            searchInput.focus();
            searchInput.select();
            e.preventDefault();
            return;
        }

        if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
            deps.showShortcuts();
            e.preventDefault();
            return;
        }

        if (e.key === 'Backspace' && plain) {
            deps.goBack();
            e.preventDefault();
            return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const filtered = state.filteredIndexes;
            if (filtered.length === 0) { return; }
            let pos = state.selectedIndex != null ? filtered.indexOf(state.selectedIndex) : -1;
            if (pos === -1) {
                pos = e.key === 'ArrowDown' ? 0 : filtered.length - 1;
            } else {
                pos = e.key === 'ArrowDown'
                    ? Math.min(filtered.length - 1, pos + 1)
                    : Math.max(0, pos - 1);
            }
            state.selectedIndex = filtered[pos];
            list.ensureVisible(pos);
            list.renderWindow();
            if (deps.isDetailOpen()) {
                deps.openDetail(state.selectedIndex);
            }
            deps.persist();
            e.preventDefault();
            return;
        }

        if (e.key === 'Enter' && state.selectedIndex != null) {
            deps.openDetail(state.selectedIndex);
            e.preventDefault();
            return;
        }

        if (e.key === ' ' && plain) {
            deps.toggleLive();
            e.preventDefault();
            return;
        }

        if (plain && e.key === 'c' && state.selectedIndex != null) {
            deps.copySelected();
            e.preventDefault();
            return;
        }

        if (plain && e.key === 'b' && state.selectedIndex != null) {
            deps.toggleBookmarkSelected();
            e.preventDefault();
            return;
        }

        if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
            deps.jumpToError(e.shiftKey ? -1 : 1);
            e.preventDefault();
            return;
        }

        if (plain && e.key === 't') {
            deps.cycleTimeMode();
            e.preventDefault();
            return;
        }

        if (e.key === 'Escape' && deps.isDetailOpen()) {
            deps.closeDetail();
            e.preventDefault();
            return;
        }

        if (e.key === 'Home' && !e.ctrlKey && !e.metaKey) {
            container.scrollTop = 0;
            if (state.filteredIndexes.length > 0) {
                state.selectedIndex = state.filteredIndexes[0];
                list.renderWindow();
                deps.persist();
            }
            e.preventDefault();
            return;
        }

        if (e.key === 'End') {
            if (e.ctrlKey || e.metaKey) {
                deps.resumeLive();
            } else {
                container.scrollTop = container.scrollHeight;
                const last = state.filteredIndexes.length - 1;
                if (last >= 0) {
                    state.selectedIndex = state.filteredIndexes[last];
                    list.renderWindow();
                    deps.persist();
                }
            }
            e.preventDefault();
            return;
        }
    });
}

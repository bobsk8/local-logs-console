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
    clearSearch: () => void;
    /** Copy the selected entry's raw JSON to the clipboard. */
    copySelected: () => void;
    persist: () => void;
}

/**
 * Global keyboard navigation:
 *   /  or Ctrl/Cmd+F   focus search        Esc (in search)  clear + leave search
 *   ↑ / ↓              move selection      Enter / Space    open details
 *   Esc                close details       Home / End       jump to top / bottom
 *   Ctrl/Cmd+End       resume live tail    c                copy selected raw JSON
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

        // Focus search
        if ((e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) ||
            (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey)) {
            searchInput.focus();
            searchInput.select();
            e.preventDefault();
            return;
        }

        // Don't interfere with other interactive elements (buttons, pills, menu)
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.closest?.('.menu-dropdown'))) {
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

        if ((e.key === 'Enter' || e.key === ' ') && state.selectedIndex != null) {
            deps.openDetail(state.selectedIndex);
            e.preventDefault();
            return;
        }

        if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey && state.selectedIndex != null) {
            deps.copySelected();
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
            e.preventDefault();
            return;
        }

        if (e.key === 'End') {
            if (e.ctrlKey || e.metaKey) {
                deps.resumeLive();
            } else {
                container.scrollTop = container.scrollHeight;
            }
            e.preventDefault();
            return;
        }
    });
}

import { UiState } from './state';

export interface EmptyStatesDeps {
    loadingEl: HTMLElement | null;
    emptyEl: HTMLElement | null;
    noResultsEl: HTMLElement | null;
    onRunCommand: () => void;
    onFollowFile: () => void;
    onClearFilters: () => void;
}

/**
 * Switches between the loading skeleton, the "no logs yet" onboarding panel
 * (with actions that start a capture) and the "no results" panel when filters
 * match nothing.
 */
export class EmptyStates {
    constructor(private readonly deps: EmptyStatesDeps) {
        deps.emptyEl?.querySelector('#empty-run-btn')?.addEventListener('click', deps.onRunCommand);
        deps.emptyEl?.querySelector('#empty-follow-btn')?.addEventListener('click', deps.onFollowFile);
        deps.noResultsEl?.querySelector('#clear-filters-btn')?.addEventListener('click', deps.onClearFilters);
    }

    update(state: UiState): void {
        const loading = !state.historyLoaded;
        const empty = state.historyLoaded && state.logsData.length === 0;
        const noResults = state.historyLoaded && state.logsData.length > 0 && state.filteredIndexes.length === 0;

        this.toggle(this.deps.loadingEl, loading);
        this.toggle(this.deps.emptyEl, empty);
        this.toggle(this.deps.noResultsEl, noResults);
    }

    private toggle(el: HTMLElement | null, show: boolean): void {
        if (el) {
            el.hidden = !show;
        }
    }
}

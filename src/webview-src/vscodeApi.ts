import { WebviewToExtensionMessage } from '../shared/protocol';

/** UI state persisted across webview reloads via vscode.setState. */
export interface PersistedState {
    selectedIndex?: number | null;
    activeLevels?: Record<string, boolean>;
    search?: string;
    scrollTop?: number;
    detailWidth?: string;
    autoScroll?: boolean;
    timeFilter?: { start: number; end: number } | null;
    density?: 'comfortable' | 'compact';
}

interface VsCodeWebviewApi {
    postMessage(message: unknown): void;
    getState(): PersistedState | undefined;
    setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

const api = acquireVsCodeApi();

export function post(message: WebviewToExtensionMessage): void {
    api.postMessage(message);
}

export function getPersistedState(): PersistedState {
    return api.getState() ?? {};
}

export function setPersistedState(state: PersistedState): void {
    api.setState(state);
}

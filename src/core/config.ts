import * as vscode from 'vscode';

const SECTION = 'localLogViewer';

function get<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

export function historyLimit(): number {
    return Math.max(100, get('historyLimit', 10000));
}

export function tailSeedBytes(): number {
    return Math.max(0, get('tail.seedBytes', 10240));
}

export function redactionEnabled(): boolean {
    return get('redaction.enabled', true);
}

export function redactionUseDefaultPatterns(): boolean {
    return get('redaction.useDefaultPatterns', true);
}

export function redactionPatterns(): string[] {
    return get('redaction.patterns', [] as string[]);
}

export function confirmRunLastCommand(): boolean {
    return get('confirmRunLastCommand', true);
}

export function inheritEnvironment(): boolean {
    return get('capture.inheritEnvironment', true);
}

export function mcpEnabled(): boolean {
    return get('mcp.enabled', true);
}

export function mcpPort(): number {
    const port = get('mcp.port', 0);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}

export function affectsConfiguration(e: vscode.ConfigurationChangeEvent): boolean {
    return e.affectsConfiguration(SECTION);
}

import * as vscode from 'vscode';
import { McpServerManager } from './mcpServerManager';

// The MCP definition-provider API landed in VS Code 1.101; engines stay at
// ^1.75, so everything here is feature-detected through local structural
// types instead of bumping @types/vscode.

interface McpHttpServerDefinitionCtor {
    new(label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string): unknown;
}

interface McpCapableApi {
    lm?: {
        registerMcpServerDefinitionProvider?(id: string, provider: unknown): vscode.Disposable;
    };
    McpHttpServerDefinition?: McpHttpServerDefinitionCtor;
}

/**
 * Registers the server with VS Code's MCP discovery (Copilot agent mode) when
 * the API exists (VS Code ≥1.101). Same-window Copilot always gets the fresh
 * port/token automatically. Returns undefined silently on older hosts —
 * Claude Code / Cursor use the copyMcpSetup command instead.
 */
export function registerMcpProviderIfAvailable(
    context: vscode.ExtensionContext,
    manager: McpServerManager
): { refresh(): void } | undefined {
    const api = vscode as unknown as McpCapableApi;
    const register = api.lm?.registerMcpServerDefinitionProvider;
    const HttpDefinition = api.McpHttpServerDefinition;
    if (typeof register !== 'function' || typeof HttpDefinition !== 'function') {
        return undefined;
    }

    const emitter = new vscode.EventEmitter<void>();
    const provider = {
        onDidChangeMcpServerDefinitions: emitter.event,
        provideMcpServerDefinitions(): unknown[] {
            if (!manager.running || !manager.endpoint || !manager.token) {
                return [];
            }
            return [new HttpDefinition(
                'Local Logs Console',
                vscode.Uri.parse(manager.endpoint),
                { Authorization: `Bearer ${manager.token}` },
                context.extension.packageJSON.version as string
            )];
        }
    };

    context.subscriptions.push(
        emitter,
        register.call(api.lm, 'localLogsConsole.mcp', provider)
    );

    return { refresh: () => emitter.fire() };
}

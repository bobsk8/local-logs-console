// Pure JSON-RPC 2.0 / MCP (Streamable HTTP, JSON-only) dispatcher.
//
// HARD RULE: this module must never import 'vscode' (or any module that does)
// at runtime — it is required from plain-Node test scripts. Type-only imports
// are fine (they erase at compile time).

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

export type JsonRpcId = string | number | null;

export interface McpTextContent {
    type: 'text';
    text: string;
}

export interface McpToolResult {
    content: McpTextContent[];
    structuredContent?: unknown;
    isError?: boolean;
}

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpDispatchDeps {
    serverInfo: { name: string; version: string };
    /** Returned from initialize — orientation text for the connecting agent. */
    instructions: string;
    listTools(): McpToolDefinition[];
    callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export type McpDispatchOutcome =
    | { kind: 'json'; status: 200; body: Record<string, unknown>; isInitialize?: boolean }
    | { kind: 'accepted'; status: 202 }
    | { kind: 'error'; status: 400; body: Record<string, unknown> };

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) {
        error.data = data;
    }
    return { jsonrpc: '2.0', id, error };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id, result };
}

/**
 * Parses, validates and routes one HTTP POST body. Pure: no sockets, no
 * vscode. The HTTP layer maps the outcome to status codes and attaches the
 * Mcp-Session-Id header when `isInitialize` is set.
 */
export async function dispatchMcpMessage(rawBody: string, deps: McpDispatchDeps): Promise<McpDispatchOutcome> {
    let message: unknown;
    try {
        message = JSON.parse(rawBody);
    } catch {
        return { kind: 'error', status: 400, body: jsonRpcError(null, -32700, 'Parse error') };
    }

    if (Array.isArray(message)) {
        // JSON-RPC batching was removed from MCP in 2025-06-18.
        return { kind: 'error', status: 400, body: jsonRpcError(null, -32600, 'Batch requests are not supported') };
    }

    if (message === null || typeof message !== 'object') {
        return { kind: 'error', status: 400, body: jsonRpcError(null, -32600, 'Invalid Request') };
    }

    const msg = message as Record<string, unknown>;
    const method = msg.method;
    const rawId = msg.id;
    const hasId = rawId !== undefined && rawId !== null;
    const id: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;

    if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
        return { kind: 'error', status: 400, body: jsonRpcError(id, -32600, 'Invalid Request') };
    }

    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params))
        ? msg.params as Record<string, unknown>
        : {};

    // Notifications (no id) are acknowledged with an empty 202 — including
    // notifications/initialized and any notification we don't recognize.
    if (!hasId) {
        return { kind: 'accepted', status: 202 };
    }

    switch (method) {
        case 'initialize': {
            const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
            const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : LATEST_PROTOCOL_VERSION;
            return {
                kind: 'json',
                status: 200,
                isInitialize: true,
                body: jsonRpcResult(id, {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: deps.serverInfo,
                    instructions: deps.instructions
                })
            };
        }

        case 'ping':
            return { kind: 'json', status: 200, body: jsonRpcResult(id, {}) };

        case 'tools/list':
            return { kind: 'json', status: 200, body: jsonRpcResult(id, { tools: deps.listTools() }) };

        case 'tools/call': {
            const name = typeof params.name === 'string' ? params.name : '';
            const known = deps.listTools().some(t => t.name === name);
            if (!known) {
                return { kind: 'json', status: 200, body: jsonRpcError(id, -32602, `Unknown tool: ${name || '(missing name)'}`) };
            }
            const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
                ? params.arguments as Record<string, unknown>
                : {};
            try {
                const result = await deps.callTool(name, args);
                return { kind: 'json', status: 200, body: jsonRpcResult(id, result) };
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                return { kind: 'json', status: 200, body: jsonRpcError(id, -32603, 'Internal error', detail) };
            }
        }

        default:
            return { kind: 'json', status: 200, body: jsonRpcError(id, -32601, 'Method not found') };
    }
}

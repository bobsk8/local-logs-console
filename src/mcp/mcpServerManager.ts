import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { LogStore } from '../store/logStore';
import { LogEventBus } from '../events/logEventBus';
import { SessionRegistry } from '../core/sessionRegistry';
import { dispatchMcpMessage, McpDispatchDeps } from './mcpProtocol';
import { createMcpTools, McpTools } from './mcpTools';
import * as config from '../core/config';

const TOKEN_SECRET_KEY = 'localLogViewer.mcp.token';
const MAX_BODY_BYTES = 256 * 1024;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const INSTRUCTIONS =
    'Local Logs Console serves the logs captured in this VS Code window (commands being run and files being tailed). ' +
    'Call get_log_stats first to see what is available, search_logs/get_errors_since to investigate, and wait_for_logs ' +
    'after triggering an action to catch its output. All log content was secret-redacted before storage.';

/** Persists the auto-selected port so external agent configs survive restarts. */
export interface PortMemory {
    get(): number | undefined;
    set(port: number): void | Thenable<void>;
}

export interface McpServerManagerDeps {
    secrets: vscode.SecretStorage;
    store: LogStore;
    registry: SessionRegistry;
    bus: LogEventBus;
    outputChannel: vscode.OutputChannel;
    serverVersion: string;
    /** Fired on start/stop/port change — refresh status bar + VS Code provider. */
    onStateChange?: () => void;
    /**
     * Remembers the port chosen in auto mode (setting = 0) so a restart reuses it
     * and saved agent configs (Claude Code, .mcp.json, Cursor) keep pointing at a
     * live endpoint. Omit to fall back to a fresh random port on every start.
     */
    portMemory?: PortMemory;
    /**
     * Fired when the auto port had to change (the remembered one was unavailable),
     * which invalidates any externally-saved agent config pointing at the old port.
     */
    onPortDrift?: (previousPort: number, currentPort: number) => void;
}

/**
 * Owns the local MCP HTTP endpoint: 127.0.0.1 only, mandatory Bearer token
 * (persistent per machine in SecretStorage so saved agent configs survive
 * restarts), Origin validation against DNS rebinding, and prompt shutdown
 * (long-polls are resolved before the server closes).
 */
export class McpServerManager implements vscode.Disposable {
    private server: http.Server | undefined;
    private tools: McpTools | undefined;
    private boundPort: number | undefined;
    private configuredPort: number | undefined;
    private sessionId = crypto.randomBytes(16).toString('hex');
    private cachedToken: string | undefined;
    private readonly sockets = new Set<import('net').Socket>();
    /** Serializes start/stop so rapid config toggles can't interleave. */
    private pending: Promise<void> = Promise.resolve();

    constructor(private readonly deps: McpServerManagerDeps) { }

    get running(): boolean {
        return this.server !== undefined;
    }

    get port(): number | undefined {
        return this.boundPort;
    }

    get endpoint(): string | undefined {
        return this.boundPort !== undefined ? `http://127.0.0.1:${this.boundPort}/mcp` : undefined;
    }

    get token(): string | undefined {
        return this.cachedToken;
    }

    /** Start/stop/restart to match the localLogViewer.mcp.* settings. */
    syncWithConfig(): Promise<void> {
        this.pending = this.pending.then(() => this.doSync()).catch(err => {
            this.deps.outputChannel.appendLine(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
        });
        return this.pending;
    }

    stop(): Promise<void> {
        this.pending = this.pending.then(() => this.doStop());
        return this.pending;
    }

    dispose(): void {
        void this.stop();
    }

    private async doSync(): Promise<void> {
        const enabled = config.mcpEnabled();
        const wantedPort = config.mcpPort();

        if (!enabled) {
            if (this.server) {
                await this.doStop();
                this.deps.outputChannel.appendLine('MCP server stopped (disabled in settings).');
            }
            return;
        }

        if (this.server && this.configuredPort === wantedPort) {
            return; // already running as configured
        }

        if (this.server) {
            await this.doStop();
        }
        await this.doStart(wantedPort);
    }

    private async ensureToken(): Promise<string> {
        if (this.cachedToken) {
            return this.cachedToken;
        }
        let token = await this.deps.secrets.get(TOKEN_SECRET_KEY);
        if (!token) {
            token = crypto.randomBytes(32).toString('base64url');
            await this.deps.secrets.store(TOKEN_SECRET_KEY, token);
        }
        this.cachedToken = token;
        return token;
    }

    private async doStart(configuredPort: number): Promise<void> {
        const token = await this.ensureToken();
        this.sessionId = crypto.randomBytes(16).toString('hex');

        this.tools = createMcpTools({
            store: this.deps.store,
            registry: this.deps.registry,
            bus: this.deps.bus,
            historyLimit: () => config.historyLimit()
        });

        const dispatchDeps: McpDispatchDeps = {
            serverInfo: { name: 'local-logs-console', version: this.deps.serverVersion },
            instructions: INSTRUCTIONS,
            listTools: () => this.tools?.definitions ?? [],
            callTool: (name, args) => {
                if (!this.tools) {
                    return Promise.reject(new Error('Server is stopping'));
                }
                return this.tools.call(name, args);
            }
        };

        const server = http.createServer((req, res) => this.handleRequest(req, res, token, dispatchDeps));
        server.on('connection', socket => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });

        // In auto mode (setting = 0) reuse the port remembered for this workspace so
        // external agent configs keep resolving to a live endpoint across restarts.
        // A pinned port is honored verbatim.
        const pinned = configuredPort !== 0;
        const rememberedPort = pinned ? undefined : this.deps.portMemory?.get();
        const preferredPort = pinned ? configuredPort : (rememberedPort ?? 0);

        let outcome = await this.listenOnce(server, preferredPort);
        if (!outcome.ok && outcome.code === 'EADDRINUSE' && !pinned && preferredPort !== 0) {
            // The remembered auto port was taken by another process — transparently
            // fall back to a fresh OS-assigned port (re-persisted below).
            this.deps.outputChannel.appendLine(
                `MCP server: remembered port ${preferredPort} is in use — selecting a new port.`
            );
            outcome = await this.listenOnce(server, 0);
        }

        if (!outcome.ok) {
            if (outcome.code === 'EADDRINUSE' && pinned) {
                this.deps.outputChannel.appendLine(`MCP server: port ${configuredPort} is in use.`);
                void vscode.window.showWarningMessage(
                    `Local Logs Console: MCP port ${configuredPort} is already in use.`,
                    'Use random port', 'Open Settings'
                ).then(choice => {
                    if (choice === 'Use random port') {
                        void this.startWithRandomPort();
                    } else if (choice === 'Open Settings') {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'localLogViewer.mcp.port');
                    }
                });
            } else {
                this.deps.outputChannel.appendLine(`MCP server failed to start: ${outcome.message}`);
            }
            this.tools.dispose();
            this.tools = undefined;
            return;
        }

        const address = server.address();
        this.boundPort = typeof address === 'object' && address ? address.port : undefined;
        this.configuredPort = configuredPort;
        this.server = server;
        // After start, errors should be logged, not crash the extension host.
        server.on('error', err => {
            this.deps.outputChannel.appendLine(`MCP server error: ${err.message}`);
        });

        // Persist the auto port so the next restart reuses it, and warn if it drifted
        // from what external configs were last pointed at (only when the old port was
        // unavailable) so the user can re-copy setup.
        if (!pinned && this.boundPort !== undefined) {
            if (rememberedPort !== this.boundPort) {
                void this.deps.portMemory?.set(this.boundPort);
            }
            if (rememberedPort !== undefined && rememberedPort !== this.boundPort) {
                this.deps.onPortDrift?.(rememberedPort, this.boundPort);
            }
        }

        this.deps.outputChannel.appendLine(
            `MCP server listening at ${this.endpoint} — run "Local Logs Console: Copy MCP Setup for Coding Agents…" to connect an agent.`
        );
        this.deps.onStateChange?.();
    }

    /** Bind once; resolves ok or with the error code so the caller can retry/warn. */
    private listenOnce(
        server: http.Server,
        port: number
    ): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
        return new Promise(resolve => {
            const onError = (err: NodeJS.ErrnoException) => {
                server.removeListener('listening', onListening);
                resolve({ ok: false, code: err.code, message: err.message });
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve({ ok: true });
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen({ host: '127.0.0.1', port });
        });
    }

    private startWithRandomPort(): Promise<void> {
        this.pending = this.pending.then(async () => {
            if (!this.server && config.mcpEnabled()) {
                await this.doStart(0);
            }
        });
        return this.pending;
    }

    private async doStop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.boundPort = undefined;
        this.configuredPort = undefined;

        // Resolve long-polls first so their responses can flush before close.
        this.tools?.dispose();
        this.tools = undefined;

        if (server) {
            await new Promise<void>(resolve => {
                server.close(() => resolve());
                // Node >=18.2 has closeAllConnections; on older runtimes destroy
                // tracked sockets so close() doesn't hang on keep-alives.
                const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
                if (typeof closeAll === 'function') {
                    closeAll.call(server);
                } else {
                    for (const socket of [...this.sockets]) {
                        socket.destroy();
                    }
                }
            });
            this.sockets.clear();
            this.deps.onStateChange?.();
        }
    }

    private handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        token: string,
        dispatchDeps: McpDispatchDeps
    ): void {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"error":"not found"}');
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
            res.end('{"error":"method not allowed"}');
            return;
        }

        // DNS-rebinding defense: browser-originated requests carry an Origin.
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin.length > 0 && !LOCAL_ORIGIN.test(origin)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end('{"error":"forbidden origin"}');
            return;
        }

        if (!this.isAuthorized(req, token)) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'WWW-Authenticate': 'Bearer realm="local-log-viewer"'
            });
            res.end('{"error":"unauthorized"}');
            return;
        }

        let body = '';
        let size = 0;
        let overflowed = false;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                overflowed = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end('{"error":"payload too large"}');
                req.destroy();
                return;
            }
            body += chunk.toString('utf8');
        });

        req.on('end', () => {
            if (overflowed) {
                return;
            }
            dispatchMcpMessage(body, dispatchDeps).then(outcome => {
                if (outcome.kind === 'accepted') {
                    res.writeHead(202);
                    res.end();
                    return;
                }
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (outcome.kind === 'json' && outcome.isInitialize) {
                    headers['Mcp-Session-Id'] = this.sessionId;
                }
                res.writeHead(outcome.status, headers);
                res.end(JSON.stringify(outcome.body));
            }).catch(err => {
                this.deps.outputChannel.appendLine(`MCP request error: ${err instanceof Error ? err.message : String(err)}`);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end('{"error":"internal error"}');
                }
            });
        });

        req.on('error', () => {
            // client aborted — nothing to do
        });
    }

    private isAuthorized(req: http.IncomingMessage, token: string): boolean {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            return false;
        }
        const presented = Buffer.from(header.slice('Bearer '.length));
        const expected = Buffer.from(token);
        if (presented.length !== expected.length) {
            return false;
        }
        try {
            return crypto.timingSafeEqual(presented, expected);
        } catch {
            return false;
        }
    }
}

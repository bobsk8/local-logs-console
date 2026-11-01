import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { LogLevel } from '../models/logEntry';
import { detectLevel } from '../logParser';
import { LineSplitter } from './lineSplitter';
import { stopChildProcess, interruptChildProcess, hasExited, StopDelays } from './processTree';
import { LogPipeline } from './logPipeline';
import { SessionRegistry } from './sessionRegistry';
import * as config from './config';

function terminalColor(level: LogLevel): string {
    switch (level) {
        case 'ERROR': return '\x1b[31m';
        case 'WARN': return '\x1b[33m';
        case 'DEBUG': return '\x1b[36m';
        case 'TRACE': return '\x1b[90m';
        default: return '\x1b[32m';
    }
}

function formatTerminalLine(line: string, level: LogLevel): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const color = terminalColor(level);
    const reset = '\x1b[0m';
    return `${hh}:${mm}:${ss} ${color}[${level}]${reset} ${line}\r\n`;
}

// Minimal environment for when the user opts out of handing the child the
// full (potentially secret-laden) process.env.
const MINIMAL_ENV_KEYS = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL',
    'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'TEMP', 'TMP'
];

/** Variables the extension host sets for itself that must not leak into user programs. */
const HOST_ONLY_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_PID', 'VSCODE_HANDLES_UNCAUGHT_ERRORS'];

/** Defaults that make piped output arrive promptly; never override the user's own values. */
const CAPTURE_ENV_DEFAULTS: Record<string, string> = { PYTHONUNBUFFERED: '1' };

export function buildChildEnv(inherit: boolean, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    let env: NodeJS.ProcessEnv;
    if (inherit) {
        env = { ...source };
        for (const key of HOST_ONLY_ENV_KEYS) {
            delete env[key];
        }
    } else {
        env = {};
        for (const key of MINIMAL_ENV_KEYS) {
            const value = source[key];
            if (value !== undefined) {
                env[key] = value;
            }
        }
    }
    for (const [key, value] of Object.entries(CAPTURE_ENV_DEFAULTS)) {
        if (env[key] === undefined) {
            env[key] = value;
        }
    }
    return env;
}

let nextSessionId = 1;

/**
 * Runs a shell command inside a vscode.Pseudoterminal, echoing colored output
 * to the terminal while feeding cleaned + redacted lines into the LogPipeline.
 * Owns the child-process lifecycle: registration in the SessionRegistry,
 * muting during intentional kills, and cross-platform tree termination.
 */
export class CaptureManager {
    private readonly runningChildren = new Set<ChildProcess>();
    private readonly mutedProcessPids = new Set<number>();

    constructor(
        private readonly pipeline: LogPipeline,
        private readonly registry: SessionRegistry,
        private readonly outputChannel: vscode.OutputChannel
    ) { }

    get hasRunning(): boolean {
        return this.runningChildren.size > 0;
    }

    /** Stops every running command; resolves when the kill escalation is done. */
    stopAll(delays?: StopDelays): Promise<void> {
        return Promise.all(
            [...this.runningChildren].map(child => stopChildProcess(child, this.mutedProcessPids, delays))
        ).then(() => undefined);
    }

    /** Runs `command` in `cwd` (default: the first workspace folder) and captures its output. */
    runAndCapture(command: string, cwd?: string): void {
        const firstFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;
        const workspaceCwd = cwd ?? firstFolder;
        // multi-root: say which folder a script runs in
        const label = cwd && cwd !== firstFolder ? `${command} (${path.basename(cwd)})` : command;

        const sessionId = `cmd-${nextSessionId++}`;
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<void>();
        let child: ChildProcess | undefined;
        /** Set once the process is gone; the next keypress closes the terminal. */
        let finished = false;
        /** Pseudoterminals have no line discipline: we echo and buffer input ourselves. */
        let inputLine = '';

        const write = (text: string) => writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: () => {
                let spawnedChild: ChildProcess;
                try {
                    spawnedChild = spawn(command, {
                        shell: true,
                        cwd: workspaceCwd,
                        env: buildChildEnv(config.inheritEnvironment()),
                        detached: process.platform !== 'win32'
                    });
                } catch (err) {
                    write(`\n[error] Could not start the process: ${err instanceof Error ? err.message : String(err)}\n`);
                    finished = true;
                    return;
                }
                child = spawnedChild;
                this.outputChannel.appendLine(`Starting command: ${command}`);
                if (workspaceCwd) {
                    this.outputChannel.appendLine(`Working directory: ${workspaceCwd}`);
                }
                write('Press Ctrl+C in this terminal to interrupt the process.\n');

                if (spawnedChild.pid) {
                    this.mutedProcessPids.delete(spawnedChild.pid);
                }

                this.runningChildren.add(spawnedChild);
                this.registry.register({
                    id: sessionId,
                    kind: 'command',
                    label,
                    startedAt: Date.now(),
                    status: 'running',
                    cwd: workspaceCwd,
                    stop: () => {
                        void stopChildProcess(spawnedChild, this.mutedProcessPids);
                    },
                    restart: () => this.runAndCapture(command, cwd)
                });

                // a process being stopped on purpose must not flood the dashboard
                const notMuted = () => {
                    const pid = spawnedChild.pid;
                    return !(pid && this.mutedProcessPids.has(pid));
                };

                // stderr is not an error channel (npm, webpack, Python logging all
                // write there) — its lines default to INFO and carry stream:stderr;
                // real errors are found by level keywords and stack grouping.
                const forward = (stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
                    if (!stream) { return; }
                    const sink = this.pipeline.openStream({
                        source: command,
                        sessionId,
                        stream: name,
                        defaultLevel: 'INFO',
                        shouldIngest: notMuted
                    });
                    const splitter = new LineSplitter(line => {
                        const echoed = sink.push(line);
                        if (echoed) {
                            writeEmitter.fire(formatTerminalLine(echoed.text, detectLevel(echoed.text, 'INFO')));
                        }
                    });
                    let ended = false;
                    const end = () => {
                        if (ended) { return; }
                        ended = true;
                        splitter.end();
                        sink.end();
                    };
                    stream.on('data', (chunk: Buffer | string) => splitter.push(chunk));
                    stream.on('end', end);
                    stream.on('error', end);
                };

                forward(spawnedChild.stdout, 'stdout');
                forward(spawnedChild.stderr, 'stderr');

                spawnedChild.stdin?.on('error', () => {
                    // EPIPE after the child exited — nothing to do
                });

                // Registry/status cleanup happens on `exit`; the summary line waits
                // for `close` (all output flushed) — or a grace period, because a
                // detached grandchild may hold stdout open indefinitely.
                let summarized = false;
                const summarize = (code: number | null, signal: NodeJS.Signals | null) => {
                    if (summarized) { return; }
                    summarized = true;
                    const pid = spawnedChild.pid;
                    const stoppedByUser = pid ? this.mutedProcessPids.has(pid) : false;
                    if (pid) {
                        this.mutedProcessPids.delete(pid);
                    }
                    const outcome = signal ? `was terminated by ${signal}` : `exited with code ${code}`;
                    this.outputChannel.appendLine(`Command ${outcome}: ${command}`);
                    write(`\nProcess ${outcome}. Press any key to close this terminal.\n`);
                    const failed = !stoppedByUser && (signal !== null || (code !== null && code !== 0));
                    // Full ingest path: the command text itself may carry secrets.
                    this.pipeline.ingest(JSON.stringify({
                        level: failed ? 'error' : 'info',
                        message: stoppedByUser ? `Process stopped (${command})` : `Process ${outcome} (${command})`,
                        event: 'exit',
                        exitCode: code,
                        signal
                    }), { source: command, sessionId });
                    finished = true;
                };

                spawnedChild.on('error', (err) => {
                    write('\n[error] ' + String(err.message || err) + '\n');
                    this.runningChildren.delete(spawnedChild);
                    this.registry.end(sessionId, 'exited', null);
                    if (!spawnedChild.pid) {
                        summarize(null, null);
                    }
                });

                spawnedChild.on('exit', (code, signal) => {
                    this.runningChildren.delete(spawnedChild);
                    const pid = spawnedChild.pid;
                    const stoppedByUser = pid ? this.mutedProcessPids.has(pid) : false;
                    this.registry.end(sessionId, stoppedByUser ? 'stopped' : 'exited', signal ? null : code);
                    setTimeout(() => summarize(code, signal), 2000);
                });

                spawnedChild.on('close', (code, signal) => summarize(code, signal));
            },
            handleInput: (data: string) => {
                if (finished) {
                    closeEmitter.fire();
                    return;
                }
                if (!child) {
                    return;
                }

                // Ctrl+C
                if (data === '\x03') {
                    writeEmitter.fire('^C\r\n');
                    inputLine = '';
                    interruptChildProcess(child, this.mutedProcessPids);
                    return;
                }

                const stdin = child.stdin;
                if (!stdin || stdin.destroyed) {
                    return;
                }
                // Ctrl+D: end of input
                if (data === '\x04') {
                    stdin.end();
                    return;
                }

                for (const ch of data) {
                    if (ch === '\r' || ch === '\n') {
                        writeEmitter.fire('\r\n');
                        const line = inputLine;
                        inputLine = '';
                        try { stdin.write(line + '\n'); } catch { /* child gone */ }
                    } else if (ch === '\x7f' || ch === '\b') {
                        if (inputLine.length > 0) {
                            inputLine = inputLine.slice(0, -1);
                            writeEmitter.fire('\b \b');
                        }
                    } else if (ch >= ' ') {
                        inputLine += ch;
                        writeEmitter.fire(ch);
                    }
                }
            },
            close: () => {
                if (child && !hasExited(child)) {
                    void stopChildProcess(child, this.mutedProcessPids);
                }
                writeEmitter.dispose();
                closeEmitter.dispose();
            }
        };

        const terminal = vscode.window.createTerminal({ name: `Run: ${command}`, pty });
        terminal.show();
    }
}

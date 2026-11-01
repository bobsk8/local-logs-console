import { ChildProcess, spawnSync } from 'child_process';

/** Parses `ps -A -o pid=,ppid=` output into a ppid → child-pids map. */
export function parsePsTable(stdout: string): Map<number, number[]> {
    const byParent = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) {
            continue;
        }
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const siblings = byParent.get(ppid);
        if (siblings) {
            siblings.push(pid);
        } else {
            byParent.set(ppid, [pid]);
        }
    }
    return byParent;
}

// BSD ps (macOS) has no `--ppid`, so list every process once and walk the
// table instead of one ps call per PID.
function getDescendantPidsPosix(rootPid: number): number[] {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    if (out.status !== 0 || !out.stdout) {
        return [];
    }

    const byParent = parsePsTable(out.stdout);
    const pids: number[] = [];
    const queue: number[] = [rootPid];

    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) {
            continue;
        }
        for (const childPid of byParent.get(current) ?? []) {
            pids.push(childPid);
            queue.push(childPid);
        }
    }

    return pids;
}

export function signalPosixProcessTree(rootPid: number, signal: NodeJS.Signals): void {
    // First try process-group signaling (children spawn with detached: true).
    try {
        process.kill(-rootPid, signal);
        return;
    } catch {
        // fall back to walking the ps table
    }

    const descendants = getDescendantPidsPosix(rootPid);

    // Signal children first, then the root process.
    for (const pid of descendants.reverse()) {
        try {
            process.kill(pid, signal);
        } catch {
            // ignore dead/unreachable child
        }
    }

    try {
        process.kill(rootPid, signal);
    } catch {
        // ignore dead/unreachable process
    }
}

export function terminateProcessTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = proc.pid;
    if (!pid) {
        return;
    }

    if (process.platform === 'win32') {
        try {
            // /T also terminates child processes on Windows.
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
            try {
                proc.kill(signal);
            } catch {
                // ignore
            }
        }
        return;
    }

    signalPosixProcessTree(pid, signal);
}

export function hasExited(proc: ChildProcess): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * After the root has exited only its process group is signalled — never the
 * bare PID or a ps-table walk from it, since that PID may already belong to
 * an unrelated process.
 */
function signalOrphanedGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // group already gone
    }
}

export interface StopDelays {
    /** ms after SIGINT before SIGTERM (POSIX). */
    term: number;
    /** ms after SIGINT before SIGKILL (POSIX). */
    kill: number;
}

const DEFAULT_STOP_DELAYS: StopDelays = { term: 500, kill: 1500 };

/**
 * Escalates SIGINT → SIGTERM → SIGKILL across the whole tree. The delays are
 * deliberate: dev servers get a chance to shut down cleanly before forcing.
 * The PID is muted first so late output from the dying process never reaches
 * the dashboard. On Windows a single `taskkill /T /F` is already forceful.
 * Resolves once the escalation is finished (or the process is already gone).
 */
export function stopChildProcess(proc: ChildProcess, mutedPids: Set<number>, delays: StopDelays = DEFAULT_STOP_DELAYS): Promise<void> {
    const pid = proc.pid;
    if (pid) {
        mutedPids.add(pid);
    }
    if (!pid || hasExited(proc)) {
        return Promise.resolve();
    }

    if (process.platform === 'win32') {
        terminateProcessTree(proc);
        return Promise.resolve();
    }

    return new Promise<void>(resolve => {
        terminateProcessTree(proc, 'SIGINT');
        const escalate = (signal: NodeJS.Signals) => {
            if (hasExited(proc)) {
                signalOrphanedGroup(pid, signal);
            } else {
                terminateProcessTree(proc, signal);
            }
        };
        setTimeout(() => escalate('SIGTERM'), delays.term);
        setTimeout(() => {
            escalate('SIGKILL');
            resolve();
        }, delays.kill);
    });
}

/** Single SIGINT (Ctrl+C path) — no escalation. */
export function interruptChildProcess(proc: ChildProcess, mutedPids: Set<number>): void {
    if (proc.pid) {
        mutedPids.add(proc.pid);
    }
    terminateProcessTree(proc, 'SIGINT');
}

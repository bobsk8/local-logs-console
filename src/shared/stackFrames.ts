// Pure stack-frame parsing — shared by the webview (clickable frames) and the
// extension host (Problems panel). DOM-free and vscode-free.

export interface StackFrame {
    /** Path exactly as printed (absolute, relative, or a bare file name for Java). */
    file: string;
    /** 1-based line number. */
    line: number;
    /** 1-based column, when the runtime prints one. */
    column?: number;
    /** Function / method name, when present. */
    fn?: string;
    /** Character range of the location inside the source line (for link rendering). */
    start: number;
    end: number;
}

// Node / V8:  at fn (path:12:5)   at path:12:5   at async fn (file:///path:12:5)
const NODE_PAREN = /^\s*at\s+(?:async\s+)?(.*?)\s+\((.+?):(\d+)(?::(\d+))?\)\s*$/;
const NODE_BARE = /^\s*at\s+(?:async\s+)?((?:[A-Za-z]:[\\/]|[\\/.~]|file:\/\/|webpack:\/\/).+?):(\d+)(?::(\d+))?\s*$/;
// Python:  File "/app/x.py", line 42, in handler
const PYTHON = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?\s*$/;
// Java / Kotlin / Scala:  at com.acme.Service.load(Service.java:42)
const JAVA = /^\s*at\s+([\w$.<>/]+)\(([\w$-]+\.(?:java|kt|scala|groovy)):(\d+)\)\s*$/;
// .NET:  at Acme.Service.Load() in C:\src\Service.cs:line 42
const DOTNET = /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/;
// Go:  \t/home/me/app/main.go:42 +0x1d
const GO = /^\s*((?:[A-Za-z]:)?[\\/][^\s:]+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;

/** Runtime-internal paths that never map to a file the user can open. */
const INTERNAL = /^(?:node:|internal\/|<anonymous>|native|\[native code\]|evalmachine)/;

function normalizePath(file: string): string {
    let f = file;
    if (f.startsWith('file://')) {
        f = decodeURIComponentSafe(f.slice('file://'.length));
        // file:///C:/x → C:/x on Windows
        if (/^\/[A-Za-z]:\//.test(f)) { f = f.slice(1); }
    }
    // webpack:///./src/x.ts → ./src/x.ts ; webpack://app/./src/x.ts → ./src/x.ts
    const webpack = /^webpack:\/\/[^/]*\/(.*)$/.exec(f);
    if (webpack) { f = webpack[1]; }
    return f;
}

function decodeURIComponentSafe(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

/** Parses one stack line, or returns null when it is not a frame with a usable location. */
export function parseStackFrame(text: string): StackFrame | null {
    if (!text || text.length > 2000) { return null; }
    let m: RegExpExecArray | null;
    let file: string;
    let line: number;
    let column: number | undefined;
    let fn: string | undefined;
    let printed: string;

    if ((m = NODE_PAREN.exec(text))) {
        fn = m[1] || undefined;
        file = m[2]; line = Number(m[3]); column = m[4] ? Number(m[4]) : undefined;
        printed = m[2] + ':' + m[3] + (m[4] ? ':' + m[4] : '');
    } else if ((m = NODE_BARE.exec(text))) {
        file = m[1]; line = Number(m[2]); column = m[3] ? Number(m[3]) : undefined;
        printed = m[1] + ':' + m[2] + (m[3] ? ':' + m[3] : '');
    } else if ((m = PYTHON.exec(text))) {
        file = m[1]; line = Number(m[2]); fn = m[3]?.trim() || undefined;
        printed = m[1];
    } else if ((m = JAVA.exec(text))) {
        fn = m[1]; file = m[2]; line = Number(m[3]);
        printed = m[2] + ':' + m[3];
    } else if ((m = DOTNET.exec(text))) {
        fn = m[1]; file = m[2]; line = Number(m[3]);
        printed = m[2] + ':line ' + m[3];
    } else if ((m = GO.exec(text))) {
        file = m[1]; line = Number(m[2]);
        printed = m[1] + ':' + m[2];
    } else {
        return null;
    }

    if (INTERNAL.test(file) || !Number.isFinite(line) || line < 1) { return null; }
    const start = text.indexOf(printed);
    return {
        file: normalizePath(file),
        line,
        column,
        fn,
        start: start === -1 ? 0 : start,
        end: start === -1 ? text.length : start + printed.length
    };
}

/** True when the frame points into dependencies rather than the user's own code. */
export function isLibraryFrame(frame: StackFrame): boolean {
    return /(?:^|[\\/])(?:node_modules|site-packages|dist-packages|vendor|\.pnpm|go\/pkg\/mod)[\\/]/.test(frame.file) ||
        /^(?:java|javax|jdk|sun|kotlin|scala|System|Microsoft)\./.test(frame.fn ?? '') && !frame.file.includes('/');
}

/** First frame that belongs to the user's code, falling back to the first frame at all. */
export function firstAppFrame(lines: readonly string[]): StackFrame | null {
    let fallback: StackFrame | null = null;
    for (const text of lines) {
        const frame = parseStackFrame(text);
        if (!frame) { continue; }
        if (!isLibraryFrame(frame)) { return frame; }
        fallback = fallback ?? frame;
    }
    return fallback;
}

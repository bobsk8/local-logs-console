// Pure logfmt parsing (`time=… level=warn msg="slow query" ms=812`) — the
// format of Go (logrus, zap's logfmt, slog TextHandler), Heroku and Rails
// tagged logs. vscode-free, shared by the parser and tests.

const PAIR = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;

/** Keys that mark a line as genuinely structured, not prose that contains a `=`. */
const STRUCTURAL_KEYS = new Set(['msg', 'message', 'level', 'lvl', 'time', 'ts', 'severity']);

function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    return value;
}

/**
 * Parses a logfmt line into a flat record, or null when the line isn't
 * logfmt. Requires at least two pairs plus either a structural key
 * (msg/level/time…) or three pairs, and that pairs make up most of the line —
 * so a URL query string or a sentence with one `=` stays plain text.
 */
export function parseLogfmt(line: string): Record<string, string> | null {
    const record: Record<string, string> = {};
    let pairs = 0;
    let covered = 0;
    let structural = false;
    PAIR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAIR.exec(line)) !== null) {
        // a pair must start at a token boundary ("a=b&c=d" is one opaque token)
        if (m.index > 0 && !/\s/.test(line[m.index - 1])) { continue; }
        record[m[1]] = unquote(m[2]);
        pairs++;
        covered += m[0].length;
        if (STRUCTURAL_KEYS.has(m[1].toLowerCase())) { structural = true; }
    }
    if (pairs < 2 || (!structural && pairs < 3)) { return null; }
    const nonSpace = line.replace(/\s+/g, '').length;
    if (covered < nonSpace * 0.6) { return null; }
    return record;
}

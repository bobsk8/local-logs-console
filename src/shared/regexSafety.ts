/**
 * Defensive regex compilation with protection against ReDoS (catastrophic backtracking).
 * This module is vscode-free and used by both the extension host and webview.
 */

export const MAX_REGEX_LENGTH = 256;
const REGEX_TIME_BUDGET_MS = 25;

/** Quantifier immediately following a quantified group — the classic (a+)+ shape. */
const NESTED_QUANTIFIER = /[*+}]\)?[*+{]/;

/**
 * Compiles a user-supplied regex defensively: length cap, nested-quantifier
 * heuristic, and a time-boxed probe against a synthetic worst-case input.
 * Returns null when the pattern is invalid or looks unsafe.
 */
export function compileSafeRegex(source: string, flags: string): RegExp | null {
    if (!source || source.length > MAX_REGEX_LENGTH) {
        return null;
    }
    if (NESTED_QUANTIFIER.test(source)) {
        return null;
    }
    let re: RegExp;
    try {
        re = new RegExp(source, flags);
    } catch {
        return null;
    }
    // Probe: catastrophic patterns explode on long non-matching input.
    const probe = 'a'.repeat(2048) + '!';
    const startedAt = Date.now();
    try {
        re.test(probe);
    } catch {
        return null;
    }
    if (Date.now() - startedAt > REGEX_TIME_BUDGET_MS) {
        return null;
    }
    return re;
}

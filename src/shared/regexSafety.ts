/**
 * Defensive regex compilation with protection against ReDoS (catastrophic backtracking).
 * This module is vscode-free and used by both the extension host and webview.
 */

export const MAX_REGEX_LENGTH = 256;
const REGEX_TIME_BUDGET_MS = 25;
/** Largest `{n,m}` bound accepted anywhere in a pattern. */
const MAX_REPEAT_BOUND = 1000;
/**
 * Largest bounded repeat allowed on a group that itself contains a quantifier
 * or alternation — keeps `(\d{1,3}\.){3}` usable while `(.*a){12}` is refused.
 */
const MAX_NESTED_REPEAT = 4;

interface GroupInfo { hasQuant: boolean; hasAlt: boolean }
interface Quantifier { length: number; max: number }

function readQuantifier(src: string, i: number): Quantifier | null {
    const c = src[i];
    if (c === '*' || c === '+') { return { length: 1, max: Infinity }; }
    if (c === '?') { return { length: 1, max: 1 }; }
    if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
        if (!m) { return null; } // a literal `{`
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : (m[3] === '' ? Infinity : Number(m[3]));
        return { length: m[0].length, max: Math.max(lo, hi) };
    }
    return null;
}

/**
 * Deterministic structural check (star height ≤ 1). Rejects the shapes that
 * backtrack exponentially regardless of input: a repeated group that contains
 * a quantifier or an alternation (`(a+)+`, `(a+?)+b`, `(\w+\s?)*$`, `(a|aa)+`),
 * backreferences, and huge `{n,m}` bounds. Unbalanced patterns are left for
 * the RegExp constructor to reject.
 */
export function isStructurallySafe(src: string): boolean {
    const stack: GroupInfo[] = [{ hasQuant: false, hasAlt: false }];
    let closedGroup: GroupInfo | null = null;

    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        const top = stack[stack.length - 1];

        if (c === '\\') {
            const next = src[i + 1];
            if (next !== undefined && /[1-9k]/.test(next)) { return false; }
            i++;
            closedGroup = null;
            continue;
        }
        if (c === '[') {
            i++;
            if (src[i] === '^') { i++; }
            if (src[i] === ']') { i++; }
            while (i < src.length && src[i] !== ']') {
                if (src[i] === '\\') { i++; }
                i++;
            }
            closedGroup = null;
            continue;
        }
        if (c === '(') {
            stack.push({ hasQuant: false, hasAlt: false });
            if (src[i + 1] === '?') { i++; } // (?: (?= (?! (?<name> (?<= — not a quantifier
            closedGroup = null;
            continue;
        }
        if (c === ')') {
            if (stack.length === 1) { return true; }
            const group = stack.pop()!;
            const parent = stack[stack.length - 1];
            parent.hasQuant = parent.hasQuant || group.hasQuant;
            parent.hasAlt = parent.hasAlt || group.hasAlt;
            closedGroup = group;
            continue;
        }
        if (c === '|') {
            top.hasAlt = true;
            closedGroup = null;
            continue;
        }
        const quant = readQuantifier(src, i);
        if (quant) {
            if (quant.max !== Infinity && quant.max > MAX_REPEAT_BOUND) { return false; }
            if (closedGroup && (closedGroup.hasQuant || closedGroup.hasAlt) && quant.max > MAX_NESTED_REPEAT) {
                return false;
            }
            top.hasQuant = true;
            i += quant.length - 1;
            if (src[i + 1] === '?') { i++; } // lazy modifier
            closedGroup = null;
            continue;
        }
        closedGroup = null;
    }
    return true;
}

/**
 * Compiles a user-supplied regex defensively: length cap, deterministic
 * structural check, and a time-boxed probe against synthetic worst-case
 * inputs as a second layer. Returns null when the pattern is invalid or
 * looks unsafe.
 */
export function compileSafeRegex(source: string, flags: string): RegExp | null {
    if (!source || source.length > MAX_REGEX_LENGTH) {
        return null;
    }
    if (!isStructurallySafe(source)) {
        return null;
    }
    let re: RegExp;
    try {
        re = new RegExp(source, flags);
    } catch {
        return null;
    }
    // Probe: polynomial patterns that slipped through still show on long non-matching input.
    const probes = ['a'.repeat(2048) + '!', ' '.repeat(1024) + '0'.repeat(1024) + '!'];
    const startedAt = Date.now();
    try {
        for (const probe of probes) {
            re.lastIndex = 0;
            re.test(probe);
        }
    } catch {
        return null;
    }
    if (Date.now() - startedAt > REGEX_TIME_BUDGET_MS) {
        return null;
    }
    re.lastIndex = 0;
    return re;
}

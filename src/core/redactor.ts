export interface RedactionResult {
    text: string;
    redacted: boolean;
}

export interface RedactorOptions {
    enabled?: boolean;
    useDefaultPatterns?: boolean;
    customPatterns?: string[];
}

interface RedactionRule {
    pattern: RegExp;
    replacement: string;
}

const REPLACEMENT = '[REDACTED]';
const MAX_CUSTOM_PATTERN_LENGTH = 256;

const SECRET_KEYS =
    'password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?';

// Rules run in order against the raw line BEFORE parsing. JSON-pair rules
// replace only the value between the quotes so a JSON line stays valid JSON
// (and therefore still parses into level/timestamp/etc.).
const DEFAULT_RULES: RedactionRule[] = [
    // AWS access key IDs
    { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REPLACEMENT },
    // Bearer/authorization tokens — keep the scheme word, redact the token
    { pattern: /\b([Bb]earer\s+)[A-Za-z0-9\-._~+/]{8,}=*/g, replacement: `$1${REPLACEMENT}` },
    // JWTs
    { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: REPLACEMENT },
    // Credentials embedded in URLs (scheme://user:pass@host)
    { pattern: /(:\/\/[^/\s:@]+:)[^@/\s]+(@)/g, replacement: `$1${REPLACEMENT}$2` },
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REPLACEMENT },
    // Slack tokens
    { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REPLACEMENT },
    // Google API keys
    { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: REPLACEMENT },
    // "password": "..." JSON pairs — value only, quotes preserved. The key may
    // carry a prefix/suffix (DB_PASSWORD, apiTokenValue, X-Api-Key).
    {
        pattern: new RegExp(`("[A-Za-z0-9_.-]*(?:${SECRET_KEYS})[A-Za-z0-9_.-]*"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi'),
        replacement: `$1${REPLACEMENT}$2`
    },
    // key=value / key: value pairs in plain text
    {
        pattern: new RegExp(`\\b([A-Za-z0-9_.-]*(?:${SECRET_KEYS})[A-Za-z0-9_.-]*\\s*[=:]\\s*)(?!\\[REDACTED\\])(?![Bb]earer\\b)[^\\s"'&;,]+`, 'gi'),
        replacement: `$1${REPLACEMENT}`
    }
];

function compileCustomPattern(source: string): RedactionRule | null {
    if (!source || source.length > MAX_CUSTOM_PATTERN_LENGTH) {
        return null;
    }
    try {
        return { pattern: new RegExp(source, 'gi'), replacement: REPLACEMENT };
    } catch {
        return null;
    }
}

/**
 * Masks secrets in a raw log line before it is parsed, stored, displayed or
 * exported. Pure class — options are injected so it stays testable without
 * VS Code; `LogPipeline` builds it from the `localLogViewer.redaction.*`
 * settings.
 */
export class Redactor {
    private readonly enabled: boolean;
    private readonly rules: RedactionRule[];

    constructor(options: RedactorOptions = {}) {
        this.enabled = options.enabled ?? true;
        const rules: RedactionRule[] = [];
        if (options.useDefaultPatterns ?? true) {
            rules.push(...DEFAULT_RULES);
        }
        for (const source of options.customPatterns ?? []) {
            const rule = compileCustomPattern(source);
            if (rule) {
                rules.push(rule);
            }
        }
        this.rules = rules;
    }

    redact(line: string): RedactionResult {
        if (!this.enabled || this.rules.length === 0) {
            return { text: line, redacted: false };
        }
        let text = line;
        let redacted = false;
        for (const rule of this.rules) {
            rule.pattern.lastIndex = 0;
            const next = text.replace(rule.pattern, rule.replacement);
            if (next !== text) {
                redacted = true;
                text = next;
            }
        }
        return { text, redacted };
    }
}

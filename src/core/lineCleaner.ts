/**
 * Strips ANSI escape sequences, VS Code shell-integration markers (OSC 633/133),
 * bracketed-paste toggles and other control characters from a captured line.
 * Pure function — unit-testable without VS Code.
 */
export function cleanLine(raw: string): string {
    try {
        let s = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        s = s.replace(/\x1B\][0-9]*;[^\x07]*\x07/g, '');
        s = s.replace(/\]633;[^\x07]*\x07/g, '');
        s = s.replace(/\]133;[^\x07]*\x07/g, '');
        s = s.replace(/\x1B\[\?2004[hl]/g, '');
        s = s.replace(/\[\?2004[hl]/g, '');
        s = s.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
        return s.trimEnd();
    } catch {
        return raw;
    }
}

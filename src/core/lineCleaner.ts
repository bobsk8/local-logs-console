/**
 * Strips ANSI escape sequences, VS Code shell-integration markers (OSC 633/133),
 * bracketed-paste toggles and other control characters from a captured line.
 * Pure function — unit-testable without VS Code.
 */
export function cleanLine(raw: string): string {
    try {
        // CSI sequences (incl. private-mode with ?, <, =, >); ESC prefix is optional
        let s = raw.replace(/\x1B?\[[?<=>]?[0-9;]*[a-zA-Z]/g, '');
        // OSC sequences (both BEL-terminated and ST-terminated)
        s = s.replace(/\x1B\][0-9]*;[^\x07\x1B]*\x1B\\/g, '');
        s = s.replace(/\x1B\][0-9]*;[^\x07]*\x07/g, '');
        s = s.replace(/\]633;[^\x07]*\x07/g, '');
        s = s.replace(/\]133;[^\x07]*\x07/g, '');
        // Remove control characters except TAB (0x09)
        s = s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
        return s.trimEnd();
    } catch {
        return raw;
    }
}

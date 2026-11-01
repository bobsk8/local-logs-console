import { LogPipeline } from './logPipeline';

export interface PasteImportResult {
    imported: number;
    skipped: number;
}

let nextPasteId = 1;

/**
 * Splits pasted text into non-empty lines and feeds them through a pipeline
 * stream (clean → redact → multi-line grouping → parse); `imported` counts lines, tagged with a shared session id for this one paste.
 * Deliberately NOT registered in SessionRegistry — pasted snapshots have no
 * stop() semantics and are complete the instant they're imported.
 */
export function importPastedText(
    pipeline: LogPipeline,
    text: string,
    label = 'pasted'
): PasteImportResult {
    const sessionId = `paste-${nextPasteId++}`;
    const lines = text.split(/\r\n|\r|\n/);
    let imported = 0;
    let skipped = 0;

    // a stream, so pasted stack traces are grouped like live ones
    const sink = pipeline.openStream({ source: label || 'pasted', sessionId });
    for (const line of lines) {
        if (!line.trim()) {
            skipped++;
            continue;
        }
        if (sink.push(line)) {
            imported++;
        } else {
            skipped++;
        }
    }
    sink.end();

    return { imported, skipped };
}

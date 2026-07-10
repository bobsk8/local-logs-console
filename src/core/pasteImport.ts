import { LogPipeline } from './logPipeline';

export interface PasteImportResult {
    imported: number;
    skipped: number;
}

let nextPasteId = 1;

/**
 * Splits pasted text into non-empty lines and feeds each through the pipeline's
 * raw-line ingest path, tagged with a shared session id for this one paste.
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

    for (const line of lines) {
        if (!line.trim()) {
            skipped++;
            continue;
        }
        const entry = pipeline.ingest(line, { source: label || 'pasted', sessionId });
        if (entry) {
            imported++;
        } else {
            skipped++;
        }
    }

    return { imported, skipped };
}

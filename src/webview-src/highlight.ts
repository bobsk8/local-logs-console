import { highlightRanges } from './lib/format';

/**
 * Writes `text` into `el`, wrapping matches of `needles` in <mark>. Built from
 * text nodes only — log content never goes through innerHTML.
 */
export function renderHighlighted(el: HTMLElement, text: string, needles: readonly string[]): void {
    const ranges = needles.length > 0 ? highlightRanges(text, needles) : [];
    if (ranges.length === 0) {
        el.textContent = text;
        return;
    }
    el.textContent = '';
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) { el.appendChild(document.createTextNode(text.slice(at, start))); }
        const mark = document.createElement('mark');
        mark.textContent = text.slice(start, end);
        el.appendChild(mark);
        at = end;
    }
    if (at < text.length) { el.appendChild(document.createTextNode(text.slice(at))); }
}

/** A codicon <span> (decorative). */
export function codicon(name: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'codicon codicon-' + name;
    span.setAttribute('aria-hidden', 'true');
    return span;
}

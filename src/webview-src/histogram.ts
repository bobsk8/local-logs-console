import { LogEntry } from '../models/logEntry';
import { UiState } from './state';
import { formatClock, formatClockShort } from './lib/format';

const HIST_BUCKETS = 60;

export interface HistogramDeps {
    el: HTMLElement | null;
    state: UiState;
    matchesBase: (log: LogEntry) => boolean;
    /** Called after interaction mutates state.timeFilter (refilter + persist + chip). */
    onTimeFilterChange: () => void;
    labelEl?: HTMLElement | null;
    labelTextEl?: HTMLElement | null;
    labelClearBtn?: HTMLElement | null;
}

interface Bucket {
    error: number;
    warn: number;
    info: number;
    debug: number;
    trace: number;
    total: number;
    [level: string]: number;
}

interface BucketRange {
    start: number;
    end: number;
}

/**
 * 60-bucket stacked volume timeline. Debounced; reads logsData (not the
 * virtualized DOM). Built from the base-filtered set (level + search) so the
 * timeline reflects the current query but does NOT collapse when a time range
 * is selected. Click toggles a single bucket; drag selects a range.
 */
export class Histogram {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private bucketRanges: BucketRange[] = [];
    private dragAnchor: number | null = null;
    private dragCurrent: number | null = null;
    private dragMoved = false;

    constructor(private readonly deps: HistogramDeps) {
        this.setupDrag();
        if (this.deps.labelClearBtn) {
            this.deps.labelClearBtn.addEventListener('click', () => {
                this.deps.state.timeFilter = null;
                this.deps.onTimeFilterChange();
                this.render();
            });
        }
    }

    schedule(): void {
        if (!this.deps.el || this.timer) { return; }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.render();
        }, 200);
    }

    clear(): void {
        this.bucketRanges = [];
        if (this.deps.el) {
            this.deps.el.innerHTML = '';
        }
        this.updateLabel();
    }

    render(): void {
        const { el, state, matchesBase } = this.deps;
        if (!el) { return; }

        const baseIdx: number[] = [];
        for (let i = 0; i < state.logsData.length; i++) {
            if (matchesBase(state.logsData[i])) { baseIdx.push(i); }
        }
        if (baseIdx.length === 0) { this.clear(); return; }

        let min = Infinity, max = -Infinity;
        const times: Record<number, number> = {};
        for (const i of baseIdx) {
            const t = new Date(state.logsData[i].timestamp).getTime();
            times[i] = t;
            if (!isNaN(t)) {
                if (t < min) { min = t; }
                if (t > max) { max = t; }
            }
        }
        if (!isFinite(min) || !isFinite(max)) { this.clear(); return; }

        const bucketMs = Math.max(1, max - min) / HIST_BUCKETS;
        const buckets: Bucket[] = [];
        this.bucketRanges = [];
        for (let b = 0; b < HIST_BUCKETS; b++) {
            buckets.push({ error: 0, warn: 0, info: 0, debug: 0, trace: 0, total: 0 });
            this.bucketRanges.push({
                start: min + b * bucketMs,
                end: (b === HIST_BUCKETS - 1) ? (max + 1) : (min + (b + 1) * bucketMs)
            });
        }
        for (const i of baseIdx) {
            const t = times[i];
            if (isNaN(t)) { continue; }
            let bi = Math.floor((t - min) / bucketMs);
            if (bi >= HIST_BUCKETS) { bi = HIST_BUCKETS - 1; }
            if (bi < 0) { bi = 0; }
            const lvl = (state.logsData[i].level || '').toLowerCase();
            const bucket = buckets[bi];
            if (bucket[lvl] === undefined) { bucket.info++; } else { bucket[lvl]++; }
            bucket.total++;
        }

        let maxTotal = 1;
        for (const b of buckets) {
            if (b.total > maxTotal) { maxTotal = b.total; }
        }

        const order = ['error', 'warn', 'info', 'debug', 'trace'] as const;
        const frag = document.createDocumentFragment();
        for (let b = 0; b < HIST_BUCKETS; b++) {
            const bucket = buckets[b];
            const range = this.bucketRanges[b];

            const bar = document.createElement('div');
            bar.className = 'hist-bar';
            bar.setAttribute('data-bucket', String(b));
            if (this.overlapsTimeFilter(range)) {
                bar.classList.add('selected');
            }

            const fill = document.createElement('div');
            fill.className = 'hist-fill';
            fill.style.height = ((bucket.total / maxTotal) * 100) + '%';
            for (const lvl of order) {
                if (bucket[lvl] > 0) {
                    const seg = document.createElement('div');
                    seg.className = 'hist-seg hist-' + lvl;
                    seg.style.flex = String(bucket[lvl]);
                    fill.appendChild(seg);
                }
            }
            bar.appendChild(fill);

            if (bucket.total > 0) {
                bar.classList.add('clickable');
                const parts = order.filter(l => bucket[l] > 0).map(l => `${bucket[l]} ${l}`).join(', ');
                const label = `${bucket.total} logs (${parts}) · ${formatClock(range.start)}–${formatClock(range.end)}`;
                bar.title = label + ' · click to filter, drag to select a range';
                bar.setAttribute('role', 'button');
                bar.setAttribute('aria-label', label);
            }
            frag.appendChild(bar);
        }
        el.innerHTML = '';
        el.appendChild(frag);
        this.updateLabel();
    }

    private updateLabel(): void {
        const { labelEl, labelTextEl, state } = this.deps;
        if (!labelEl || !labelTextEl) { return; }
        if (state.timeFilter) {
            labelTextEl.textContent = `${formatClockShort(state.timeFilter.start)} – ${formatClockShort(state.timeFilter.end)}`;
            labelEl.hidden = false;
        } else {
            labelEl.hidden = true;
        }
    }

    private overlapsTimeFilter(range: BucketRange): boolean {
        const tf = this.deps.state.timeFilter;
        return !!tf && range.start < tf.end && range.end > tf.start;
    }

    private barIndexFromEvent(e: Event): number | null {
        const target = e.target as HTMLElement | null;
        const bar = target?.closest?.('.hist-bar') as HTMLElement | null;
        if (!bar) { return null; }
        const bi = Number(bar.getAttribute('data-bucket'));
        return Number.isInteger(bi) ? bi : null;
    }

    private setupDrag(): void {
        const el = this.deps.el;
        if (!el) { return; }

        el.addEventListener('pointerdown', (e) => {
            const bi = this.barIndexFromEvent(e);
            if (bi === null) { return; }
            this.dragAnchor = bi;
            this.dragCurrent = bi;
            this.dragMoved = false;
            try { el.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
        });

        el.addEventListener('pointermove', (e) => {
            if (this.dragAnchor === null) { return; }
            const bi = this.barIndexFromElementPoint(e);
            if (bi !== null && bi !== this.dragCurrent) {
                this.dragCurrent = bi;
                this.dragMoved = true;
                this.previewRange(Math.min(this.dragAnchor, bi), Math.max(this.dragAnchor, bi));
            }
        });

        const finish = (e: PointerEvent) => {
            if (this.dragAnchor === null) { return; }
            const anchor = this.dragAnchor;
            const current = this.dragCurrent ?? anchor;
            this.dragAnchor = null;
            this.dragCurrent = null;
            try { el.releasePointerCapture(e.pointerId); } catch { }

            const lo = Math.min(anchor, current);
            const hi = Math.max(anchor, current);
            if (lo >= this.bucketRanges.length) { return; }
            const start = this.bucketRanges[lo].start;
            const end = this.bucketRanges[Math.min(hi, this.bucketRanges.length - 1)].end;
            const state = this.deps.state;

            if (!this.dragMoved) {
                // plain click: toggle the single bucket
                if (state.timeFilter && Math.abs(state.timeFilter.start - start) < 0.5 && Math.abs(state.timeFilter.end - end) < 0.5) {
                    state.timeFilter = null;
                } else {
                    state.timeFilter = { start, end };
                }
            } else {
                state.timeFilter = { start, end };
            }
            this.deps.onTimeFilterChange();
            this.render();
        };
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', () => {
            this.dragAnchor = null;
            this.dragCurrent = null;
        });
    }

    /** With pointer capture, e.target stays the origin bar — hit-test by X instead. */
    private barIndexFromElementPoint(e: PointerEvent): number | null {
        const el = this.deps.el;
        if (!el) { return null; }
        const bars = el.querySelectorAll('.hist-bar');
        if (bars.length === 0) { return null; }
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = Math.min(0.999, Math.max(0, x / rect.width));
        return Math.floor(ratio * bars.length);
    }

    private previewRange(lo: number, hi: number): void {
        const el = this.deps.el;
        if (!el) { return; }
        el.querySelectorAll('.hist-bar').forEach((bar, idx) => {
            bar.classList.toggle('selecting', idx >= lo && idx <= hi);
        });
    }
}

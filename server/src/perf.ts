/** In-process rolling latency stats for the ops console (docs/ops.md → 模型).
 *
 *  Deliberately memoryless across restarts: the operator asks "how fast is this box
 *  right now", and a restart — new model file, new sidecar, new hardware — is exactly
 *  when the old numbers stop meaning anything. Nothing is written to disk.
 *
 *  Failures are counted but never enter the percentile window: one 120s inference
 *  timeout would otherwise bury the p95 that the panel exists to show. */

/** Samples kept per label. 128 is enough to characterise a NAS that serves a photo
 *  every few seconds, and old samples aging out is a feature after a model swap. */
const WINDOW = 128;
/** Labels are code constants; this only guards against a future bug passing a
 *  per-request string (an id, a filename) as a label and growing the map forever. */
const MAX_LABELS = 32;

/** Canonical order for the panel. Labels not listed here still record fine — they
 *  just sort after these. */
export const LABELS = {
  depthSidecar: 'depth.sidecar',
  depthLocal: 'depth.local',
  depthPipeline: 'depth.pipeline',
  mattingSidecar: 'matting.sidecar',
  mattingLocal: 'matting.local',
  faceDetect: 'face.detect',
  faceEmbed: 'face.embed',
  faceScan: 'face.scan',
  llmBlocking: 'llm.blocking',
  llmStream: 'llm.stream.ttfb',
  exportCard: 'export.card',
  exportAnnual: 'export.annual',
  queueWait: 'queue.wait',
  queueRun: 'queue.run',
} as const;

const ORDER: string[] = Object.values(LABELS);

interface LabelState {
  count: number;
  failures: number;
  okTotalMs: number;
  ring: Float64Array;
  filled: number;
  cursor: number;
  lastMs: number;
  lastAt: number;
  lastOk: boolean;
}

const states = new Map<string, LabelState>();

function stateFor(label: string): LabelState | null {
  let s = states.get(label);
  if (!s) {
    if (states.size >= MAX_LABELS) return null;
    s = {
      count: 0,
      failures: 0,
      okTotalMs: 0,
      ring: new Float64Array(WINDOW),
      filled: 0,
      cursor: 0,
      lastMs: 0,
      lastAt: 0,
      lastOk: true,
    };
    states.set(label, s);
  }
  return s;
}

/** O(1), no allocation — safe to call on every inference. */
export function record(label: string, ms: number, ok = true): void {
  const s = stateFor(label);
  if (!s) return;
  s.count++;
  s.lastMs = ms;
  s.lastAt = Date.now();
  s.lastOk = ok;
  if (!ok) {
    s.failures++;
    return;
  }
  s.okTotalMs += ms;
  s.ring[s.cursor] = ms;
  s.cursor = (s.cursor + 1) % WINDOW;
  if (s.filled < WINDOW) s.filled++;
}

/** Times `fn`, records either outcome, and rethrows failures untouched. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    record(label, performance.now() - t0, true);
    return out;
  } catch (error) {
    record(label, performance.now() - t0, false);
    throw error;
  }
}

export interface PerfStat {
  label: string;
  count: number;
  failures: number;
  /** null until at least one success — a label with only failures has no latency. */
  p50: number | null;
  p95: number | null;
  avgMs: number | null;
  lastMs: number | null;
  lastAt: number | null;
  lastOk: boolean;
}

function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i]!;
}

function statOf(label: string, s: LabelState | undefined): PerfStat {
  if (!s || s.count === 0)
    return { label, count: 0, failures: 0, p50: null, p95: null, avgMs: null, lastMs: null, lastAt: null, lastOk: true };
  const ok = s.count - s.failures;
  let p50: number | null = null;
  let p95: number | null = null;
  if (s.filled) {
    // 128 numbers sorted on an operator's page load — not on the hot path.
    const w = Array.from(s.ring.subarray(0, s.filled)).sort((a, b) => a - b);
    p50 = percentile(w, 0.5);
    p95 = percentile(w, 0.95);
  }
  return {
    label,
    count: s.count,
    failures: s.failures,
    p50,
    p95,
    avgMs: ok ? s.okTotalMs / ok : null,
    lastMs: s.lastMs,
    lastAt: s.lastAt,
    lastOk: s.lastOk,
  };
}

/** Every canonical label (zeroed when unseen, so the panel renders a stable table)
 *  followed by anything else that showed up. */
export function snapshot(): PerfStat[] {
  const rows = ORDER.map((label) => statOf(label, states.get(label)));
  for (const [label, s] of states) if (!ORDER.includes(label)) rows.push(statOf(label, s));
  return rows;
}

export function reset(): void {
  states.clear();
}

/** On-demand benchmark for the ops console: runs each model once (twice for depth, so
 *  the second number is free of first-shape compilation) against a synthetic image and
 *  reports what it measured.
 *
 *  Two rules shape this file. It never touches user data — the input is generated from
 *  a fixed formula, and the ephemeral key it hands the cache layer is thrown away and
 *  the cache entries deleted afterwards. And it never jumps the queue: every inference
 *  goes in at 'batch' priority, behind whatever a live user is waiting for. */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { clearDepthCaches, computeDepth } from '../depth.ts';
import { benchEmbed, deleteScopeCaches, detectFaces } from '../face.ts';
import { enqueueInference } from '../inferenceQueue.ts';
import { LABELS, snapshot, type PerfStat } from '../perf.ts';
import { xaiChat } from '../xai.ts';
import { invalidateModelsSnapshot } from './modelInfo.ts';

const BENCH_OWNER = 'ops-bench';
const BENCH_SCOPE = 'ops-bench';
const PROBE_TIMEOUT_MS = 90_000;
const LLM_TIMEOUT_MS = 20_000;

export interface BenchRow {
  key: 'depth' | 'face-det' | 'face-rec' | 'llm';
  label: string;
  status: 'ok' | 'error' | 'disabled' | 'mocked';
  /** one entry per run, milliseconds */
  runs: number[];
  /** which path actually served it, when the instrumentation can tell */
  backend: string | null;
  note: string | null;
}

export interface BenchResult {
  startedAt: number;
  finishedAt: number;
  rows: BenchRow[];
  /** perf labels that moved during the run — the per-stage breakdown */
  deltas: { label: string; calls: number; lastMs: number | null }[];
}

let inFlight: { operator: string; startedAt: number } | null = null;

export function benchInFlight(): { operator: string; startedAt: number } | null {
  return inFlight;
}

/** Deterministic photo-shaped input: a smooth gradient with a few blocks, so depth has
 *  structure to find and the JPEG is a realistic size. `seed` shifts the pixels enough
 *  to give the second run a different content hash (and therefore a real cache miss). */
async function syntheticPhoto(seed: number): Promise<Buffer> {
  const w = 1024;
  const h = 768;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const block = ((x >> 7) + (y >> 7)) % 2 ? 40 : 0;
      raw[i] = (x * 255) / w + block + seed;
      raw[i + 1] = (y * 255) / h + block;
      raw[i + 2] = 255 - (x * 255) / w / 2 - block;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), PROBE_TIMEOUT_MS).unref(),
    ),
  ]);
}

const callsOf = (stats: PerfStat[], label: string): number =>
  stats.find((s) => s.label === label)?.count ?? 0;

/** Which depth path served the runs, read from the same counters real traffic feeds —
 *  one source of truth rather than a second guess local to the benchmark. */
function backendFrom(before: PerfStat[], after: PerfStat[], sidecar: string, local: string): string | null {
  const viaSidecar = callsOf(after, sidecar) - callsOf(before, sidecar) > 0;
  const viaLocal = callsOf(after, local) - callsOf(before, local) > 0;
  if (viaSidecar && viaLocal) return 'sidecar→本地回落';
  if (viaSidecar) return 'sidecar';
  if (viaLocal) return '本地 CPU';
  return null;
}

async function benchDepth(before: PerfStat[]): Promise<BenchRow> {
  const row: BenchRow = { key: 'depth', label: '深度 + 抠图管线', status: 'ok', runs: [], backend: null, note: null };
  const udk = randomBytes(32);
  try {
    for (let i = 0; i < 2; i++) {
      const photo = await syntheticPhoto(i * 7);
      const t0 = performance.now();
      await withTimeout(
        'depth',
        enqueueInference(() => computeDepth(photo, BENCH_OWNER, udk), { priority: 'batch' }),
      );
      row.runs.push(performance.now() - t0);
    }
    row.backend = backendFrom(before, snapshot(), LABELS.depthSidecar, LABELS.depthLocal);
  } catch (e) {
    row.status = 'error';
    row.note = String((e as Error).message ?? e).slice(0, 200);
  } finally {
    // the synthetic photo left two encrypted cache files behind — they are useless
    await clearDepthCaches(BENCH_OWNER).catch(() => 0);
  }
  return row;
}

async function benchFaceDetect(): Promise<BenchRow> {
  const row: BenchRow = { key: 'face-det', label: '人脸检测 (det_10g)', status: 'ok', runs: [], backend: '本地 CPU', note: null };
  const scopeKey = randomBytes(32);
  try {
    const photo = await syntheticPhoto(3);
    const t0 = performance.now();
    const faces = await withTimeout(
      'face',
      enqueueInference(() => detectFaces(photo, BENCH_SCOPE, scopeKey), { priority: 'batch' }),
    );
    row.runs.push(performance.now() - t0);
    row.note = `合成图上检出 ${faces.length} 张人脸(预期 0)`;
  } catch (e) {
    row.status = 'error';
    row.note = String((e as Error).message ?? e).slice(0, 200);
  } finally {
    await deleteScopeCaches(BENCH_SCOPE).catch(() => undefined);
  }
  return row;
}

async function benchFaceRecognise(): Promise<BenchRow> {
  const row: BenchRow = {
    key: 'face-rec',
    label: '人脸识别 (w600k_r50)',
    status: 'ok',
    runs: [],
    backend: '本地 CPU',
    note: '合成对齐图,不经过检测',
  };
  try {
    row.runs.push(await withTimeout('embed', enqueueInference(() => benchEmbed(), { priority: 'batch' })));
  } catch (e) {
    row.status = 'error';
    row.note = String((e as Error).message ?? e).slice(0, 200);
  }
  return row;
}

async function benchLlm(): Promise<BenchRow> {
  const row: BenchRow = { key: 'llm', label: 'AI provider 连通性', status: 'ok', runs: [], backend: null, note: null };
  const t0 = performance.now();
  try {
    // No meterId: a benchmark must not land on anyone's usage bill. The cost of this one
    // tiny call is the price of knowing the provider answers at all.
    const res = await xaiChat(
      { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
      AbortSignal.timeout(LLM_TIMEOUT_MS),
    );
    row.runs.push(performance.now() - t0);
    if (!res.ok) {
      row.status = 'error';
      row.note = `HTTP ${res.status}`;
    } else {
      row.note = '首字节即完整响应(非流式)';
    }
  } catch (e) {
    row.status = 'error';
    row.runs.push(performance.now() - t0);
    row.note = String((e as Error).message ?? e).slice(0, 200);
  }
  return row;
}

export async function runBenchmark(operator: string): Promise<BenchResult> {
  if (inFlight) {
    const busy = new Error('benchmark already running') as Error & { code: string };
    busy.code = 'CONFLICT';
    throw busy;
  }
  const startedAt = Date.now();
  inFlight = { operator, startedAt };
  const before = snapshot();
  try {
    const inferenceOff = process.env.INFERENCE_DISABLED === '1';
    const disabled = (key: BenchRow['key'], label: string): BenchRow => ({
      key,
      label,
      status: 'disabled',
      runs: [],
      backend: null,
      note: 'INFERENCE_DISABLED=1',
    });

    const rows: BenchRow[] = inferenceOff
      ? [
          disabled('depth', '深度 + 抠图管线'),
          disabled('face-det', '人脸检测 (det_10g)'),
          disabled('face-rec', '人脸识别 (w600k_r50)'),
        ]
      : [await benchDepth(before), await benchFaceDetect(), await benchFaceRecognise()];

    rows.push(
      process.env.MOCK_AI === '1'
        ? { key: 'llm', label: 'AI provider 连通性', status: 'mocked', runs: [], backend: null, note: 'MOCK_AI=1,未发出真实请求' }
        : await benchLlm(),
    );

    const after = snapshot();
    const deltas = after
      .map((s) => ({ label: s.label, calls: s.count - callsOf(before, s.label), lastMs: s.lastMs }))
      .filter((d) => d.calls > 0);

    invalidateModelsSnapshot();
    return { startedAt, finishedAt: Date.now(), rows, deltas };
  } finally {
    inFlight = null;
  }
}

/** One audit line, compact enough to survive the 256-char truncation. */
export function benchSummary(result: BenchResult): string {
  return result.rows
    .map((r) => {
      if (r.status !== 'ok') return `${r.key}=${r.status}`;
      const ms = r.runs.map((v) => Math.round(v)).join('/');
      return `${r.key}=${ms}ms${r.backend ? `(${r.backend})` : ''}`;
    })
    .join(' ');
}

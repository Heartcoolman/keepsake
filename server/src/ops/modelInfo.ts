/** Model/runtime panel data for the ops console (docs/ops.md → 模型).
 *
 *  Everything here is structural: filenames, sizes, backends, latencies. No user data
 *  can reach this module — it never takes a key and never reads an entry.
 *
 *  Note the import discipline: depth.ts and face.ts have public stubs, so importing
 *  them is safe in any clone. matting.ts does NOT exist in the public tree — its state
 *  arrives folded into describeInference(). Never import it here. */
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeInference } from '../depth.ts';
import { describeFace } from '../face.ts';
import type { FaceDescription, InferenceDescription } from '../modelTypes.ts';
import { describeAi } from '../xai.ts';
import { fontStatus, type FontStatus } from '../exports/render.ts';
import { jobStats } from '../annual.ts';
import { queueStats } from '../inferenceQueue.ts';
import { snapshot, type PerfStat } from '../perf.ts';

const MODELS_DIR = fileURLToPath(new URL('../../models/', import.meta.url));
/** Weight files the code can still fall back to. Anything else on disk is dead weight
 *  an operator should know about — the matting line has accumulated 141MB of it. */
const FALLBACK_FILES = new Set(['matting-v5.onnx', 'matting-v4.onnx', 'matting-v4dual.onnx']);
const PROBE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3000;

export interface ModelFile {
  name: string;
  bytes: number;
  modifiedAt: number;
  role: 'active' | 'fallback' | 'orphan';
}

export interface ModelSlot {
  key: 'depth' | 'matting' | 'face-det' | 'face-rec';
  label: string;
  file: string | null;
  version: string | null;
  backend: 'sidecar' | 'local' | 'unavailable';
  warm: boolean;
}

export interface SidecarStatus {
  key: 'depth' | 'matting';
  url: string | null;
  configured: boolean;
  ok: boolean | null;
  detail: string;
  probeMs: number | null;
  checkedAt: number | null;
}

export interface ModelsSnapshot {
  generatedAt: number;
  flags: { inferenceDisabled: boolean; mockAi: boolean };
  slots: ModelSlot[];
  files: ModelFile[];
  sidecars: SidecarStatus[];
  ai: ReturnType<typeof describeAi>;
  fonts: FontStatus;
  appTz: string;
  annual: ReturnType<typeof jobStats>;
  queue: ReturnType<typeof queueStats>;
  perf: PerfStat[];
}

function slotsOf(inference: InferenceDescription, face: FaceDescription): ModelSlot[] {
  return [
    {
      key: 'depth',
      label: '深度',
      file: inference.depth.modelFile,
      version: inference.depth.outputVersion,
      backend: inference.available ? inference.depth.backend : 'unavailable',
      warm: inference.depth.warm,
    },
    {
      key: 'matting',
      label: '抠图 / 语义',
      file: inference.matting.modelFile,
      version: inference.matting.version,
      backend: inference.available ? inference.matting.backend : 'unavailable',
      warm: inference.matting.warm,
    },
    {
      key: 'face-det',
      label: '人脸检测',
      file: face.det.file,
      version: face.modelVersion,
      backend: face.available && face.det.present ? 'local' : 'unavailable',
      warm: face.det.warm,
    },
    {
      key: 'face-rec',
      label: '人脸识别',
      file: face.rec.file,
      version: face.thumbVersion,
      backend: face.available && face.rec.present ? 'local' : 'unavailable',
      warm: face.rec.warm,
    },
  ];
}

async function listModelFiles(active: Set<string>): Promise<ModelFile[]> {
  let names: string[] = [];
  try {
    names = await readdir(MODELS_DIR);
  } catch {
    return [];
  }
  const out: ModelFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.onnx')) continue;
    const info = await stat(MODELS_DIR + name).catch(() => null);
    if (!info?.isFile()) continue;
    out.push({
      name,
      bytes: info.size,
      modifiedAt: info.mtimeMs,
      role: active.has(name) ? 'active' : FALLBACK_FILES.has(name) ? 'fallback' : 'orphan',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const probeCache = new Map<string, { at: number; status: SidecarStatus }>();

async function probeSidecar(key: 'depth' | 'matting', url: string | null): Promise<SidecarStatus> {
  if (!url)
    return { key, url: null, configured: false, ok: null, detail: '未配置', probeMs: null, checkedAt: null };
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.status;

  const t0 = performance.now();
  let status: SidecarStatus;
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await res.text()).trim().slice(0, 120);
    status = {
      key,
      url,
      configured: true,
      ok: res.ok,
      detail: res.ok ? body || 'ok' : `HTTP ${res.status}`,
      probeMs: performance.now() - t0,
      checkedAt: Date.now(),
    };
  } catch (e) {
    status = {
      key,
      url,
      configured: true,
      ok: false,
      // the message names the failure mode (timeout / ECONNREFUSED); it is our own text
      detail: String((e as Error).message ?? e).slice(0, 120),
      probeMs: performance.now() - t0,
      checkedAt: Date.now(),
    };
  }
  probeCache.set(key, { at: Date.now(), status });
  return status;
}

let cached: { at: number; data: ModelsSnapshot } | null = null;
const SNAPSHOT_TTL_MS = 15_000;

export async function getModelsSnapshot(refresh = false): Promise<ModelsSnapshot> {
  if (!refresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;
  if (refresh) probeCache.clear();

  const inference = describeInference();
  const face = describeFace();
  const slots = slotsOf(inference, face);
  const active = new Set(slots.map((s) => s.file).filter((f): f is string => Boolean(f)));

  const data: ModelsSnapshot = {
    generatedAt: Date.now(),
    flags: {
      inferenceDisabled: process.env.INFERENCE_DISABLED === '1',
      mockAi: process.env.MOCK_AI === '1',
    },
    slots,
    files: await listModelFiles(active),
    sidecars: [
      await probeSidecar('depth', inference.depth.sidecarUrl),
      await probeSidecar('matting', inference.matting.sidecarUrl),
    ],
    ai: describeAi(),
    fonts: await fontStatus(),
    appTz: process.env.APP_TZ || 'Asia/Shanghai',
    annual: jobStats(),
    queue: queueStats(),
    perf: snapshot(),
  };
  cached = { at: Date.now(), data };
  return data;
}

/** The bench endpoint changes warm flags and perf rows — drop the cache so the next
 *  panel load is not stale. */
export function invalidateModelsSnapshot(): void {
  cached = null;
}

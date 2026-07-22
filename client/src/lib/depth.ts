/** Depth for the particle cloud — server-first, in-browser fallback.
 *  The server (NAS) runs Depth Anything V2 + fg/bg layer decomposition and caches per
 *  photo; when it is unreachable we fall back to the old transformers.js path
 *  (~40MB weights downloaded on first use, single-layer only). */

export interface DepthMap {
  /** 0..1 per pixel, 1 = nearest to camera */
  data: Float32Array;
  width: number;
  height: number;
}

/** server-computed layer decomposition: fg mask + inpainted occluded background */
export interface DepthLayers {
  width: number;
  height: number;
  /** cleaned depth, 255 = near */
  depth: Uint8Array;
  /** 255 = foreground */
  mask: Uint8Array;
  /** inpainted background RGB (subject removed) */
  bg: Uint8Array;
  /** inpainted background depth */
  bgDepth: Uint8Array;
}

export interface DepthResult {
  depth: DepthMap | null;
  layers: DepthLayers | null;
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function serverDepth(entryId: string, signal?: AbortSignal): Promise<DepthResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000); // first call may wait on model download
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // computed from the server-stored image (precached at upload) — nothing to upload
    const { apiFetch } = await import('./http');
    const res = await apiFetch(`/api/v1/entries/${entryId}/depth`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      width: number;
      height: number;
      layered: boolean;
      depth: string;
      mask?: string;
      bg?: string;
      bgDepth?: string;
    };
    const depthU8 = fromB64(j.depth);
    const depth: DepthMap = {
      data: Float32Array.from(depthU8, (v) => v / 255),
      width: j.width,
      height: j.height,
    };
    if (!j.layered || !j.mask || !j.bg || !j.bgDepth) return { depth, layers: null };
    console.info(`[depth] server layers ready ${j.width}x${j.height}`);
    return {
      depth,
      layers: {
        width: j.width,
        height: j.height,
        depth: depthU8,
        mask: fromB64(j.mask),
        bg: fromB64(j.bg),
        bgDepth: fromB64(j.bgDepth),
      },
    };
  } catch (e) {
    console.warn('[depth] server unavailable, falling back to in-browser model', e);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// ---------- in-browser fallback (transformers.js) ----------

interface BrowserDepthResult {
  depth: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
}
type DepthPipeline = (input: string) => Promise<BrowserDepthResult>;

const MODEL = 'onnx-community/depth-anything-v2-small';
let loader: Promise<DepthPipeline | null> | null = null;

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  // navigator.gpu may exist while no adapter is usable (headless/old GPUs) — probe for real
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    // fall through
  }
  return 'wasm';
}

async function tryLoad(): Promise<DepthPipeline> {
  const { pipeline } = await import('@huggingface/transformers');
  const device = await pickDevice();
  console.info(`[depth] backend: ${device}`);
  return (await pipeline('depth-estimation', MODEL, { device })) as unknown as DepthPipeline;
}

async function loadPipeline(): Promise<DepthPipeline | null> {
  const { env } = await import('@huggingface/transformers');
  try {
    return await tryLoad();
  } catch (e) {
    console.warn('[depth] huggingface.co unreachable, retrying via hf-mirror.com', e);
  }
  try {
    // huggingface.co is blocked in some regions — retry through the community mirror
    (env as { remoteHost?: string }).remoteHost = 'https://hf-mirror.com';
    return await tryLoad();
  } catch (e) {
    console.warn('[depth] model unavailable', e);
    return null;
  }
}

async function browserDepth(blob: Blob, signal?: AbortSignal): Promise<DepthMap | null> {
  if (signal?.aborted) return null;
  loader ??= loadPipeline();
  const pipe = await loader;
  if (signal?.aborted) return null;
  if (!pipe) return null;
  const url = URL.createObjectURL(blob);
  try {
    const { depth } = await pipe(url);
    if (signal?.aborted) return null;
    const n = depth.width * depth.height;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = depth.data[i]! / 255;
    console.info(`[depth] map ready ${depth.width}x${depth.height}`);
    return { data, width: depth.width, height: depth.height };
  } catch (e) {
    console.warn('[depth] estimation failed', e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function estimateDepth(blob: Blob, entryId: string, signal?: AbortSignal): Promise<DepthResult> {
  const server = await serverDepth(entryId, signal);
  if (server) return server;
  return { depth: await browserDepth(blob, signal), layers: null };
}

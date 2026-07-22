/** PUBLIC STUB — the real monocular-depth pipeline (Depth Anything V2 inference,
 *  robust normalization, fg/bg split, push-pull background inpainting) lives in the
 *  private core module.
 *
 *  The encrypted per-photo cache housekeeping stays real: ops/purge.ts and
 *  ops/opsRoutes.ts call it unconditionally, and cache hits from a previous
 *  full deployment keep working. Only a cache miss requires inference and throws;
 *  those call sites are gated behind INFERENCE_DISABLED=1 or return UNAVAILABLE. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.ts';

const local = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const CACHE_DIR = local('../cache/depth/');

/** kick off model download + session init at server start so first request is fast */
export function prewarmDepth(): void {
  // no model in the public build — nothing to prewarm
}

const validDepthJson = (raw: string): boolean => {
  try {
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown; depth?: unknown; layered?: unknown };
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
      typeof parsed.depth === 'string' && typeof parsed.layered === 'boolean';
  } catch {
    return false;
  }
};

/** Cache-only read keyed by the entry's plaintext imageHash — no image bytes
 *  needed, so callers can skip decrypting the photo on a hit. Migrates a legacy
 *  bare-hash plaintext cache into the owner's key on first read. */
export async function readDepthCache(ownerId: string, imageHash: string, udk: Buffer): Promise<string | null> {
  if (!imageHash) return null;
  const cacheFile = CACHE_DIR + `${ownerId}-${imageHash}.json`;
  try {
    const cached = await readFile(cacheFile);
    if (isEncryptedBuffer(cached)) {
      const json = decryptBuffer(cached, udk).toString('utf8');
      if (validDepthJson(json)) return json;
    }
  } catch {
    // cache miss
  }
  try {
    // legacy plaintext cache keyed by bare hash — adopt into the owner's key
    const legacyFile = CACHE_DIR + imageHash + '.json';
    const legacy = await readFile(legacyFile);
    if (!isEncryptedBuffer(legacy) && validDepthJson(legacy.toString('utf8'))) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeAtomic(cacheFile, encryptBuffer(legacy, udk));
      await rm(legacyFile, { force: true });
      return legacy.toString('utf8');
    }
  } catch {
    // no legacy cache either
  }
  return null;
}

export async function computeDepth(input: Buffer, ownerId: string, udk: Buffer): Promise<string> {
  const hash = createHash('sha256').update(input).digest('hex');
  const cached = await readDepthCache(ownerId, hash, udk);
  if (cached) return cached;
  throw new Error('depth inference is part of the private core module — not available in this build');
}

/** Ops: drop depth caches — one owner's (account purge) or every one (cache clear).
 *  Purely derived data; recomputed on demand while the owner's key is present. */
export async function clearDepthCaches(ownerId?: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (ownerId && !f.startsWith(`${ownerId}-`)) continue;
    await rm(CACHE_DIR + f, { force: true });
    removed++;
  }
  return removed;
}

/** Login-triggered sweep: adopt a legacy bare-hash plaintext cache into the owner's key. */
export async function migrateLegacyDepthCache(
  imageHash: string,
  ownerId: string,
  udk: Buffer,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(imageHash)) return;
  try {
    const legacyFile = CACHE_DIR + imageHash + '.json';
    const legacy = await readFile(legacyFile);
    if (isEncryptedBuffer(legacy)) return;
    if (!validDepthJson(legacy.toString('utf8'))) return;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeAtomic(CACHE_DIR + `${ownerId}-${imageHash}.json`, encryptBuffer(legacy, udk));
    await rm(legacyFile, { force: true });
  } catch {
    // no legacy cache
  }
}

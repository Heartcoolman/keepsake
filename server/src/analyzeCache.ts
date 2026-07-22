/** Disk cache for analyze results, keyed by ownerId + image sha256, stored as an
 *  AES-GCM envelope under the owner's UDK (LLM copy is derived from the photo).
 *  Same photo bytes for different users do not share opener/description/mood. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope } from './crypto.ts';

export interface AnalyzeResult {
  opener: string;
  imageDescription: string;
  mood: string;
}

const CACHE_DIR = fileURLToPath(new URL('../cache/analyze/', import.meta.url));
const enqueue = createKeyedQueue();

export const hashImage = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Scope cache keys per owner so household members do not share LLM copy. */
export function analyzeCacheKey(ownerId: string, imageHash: string): string {
  const owner = (ownerId || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'anon';
  return `${owner}-${imageHash}`;
}

function validResult(raw: Partial<AnalyzeResult>): AnalyzeResult | null {
  if (typeof raw.opener !== 'string' || !raw.opener.trim() ||
    typeof raw.imageDescription !== 'string' || !raw.imageDescription.trim() ||
    typeof raw.mood !== 'string')
    return null;
  return {
    opener: raw.opener.slice(0, 20_000),
    imageDescription: raw.imageDescription.slice(0, 20_000),
    mood: raw.mood.slice(0, 100),
  };
}

export async function readAnalyzeCache(key: string, udk: Buffer): Promise<AnalyzeResult | null> {
  try {
    const raw = JSON.parse(await readFile(CACHE_DIR + key + '.json', 'utf8')) as Record<string, unknown>;
    if (isEnvelope(raw.enc)) return validResult(decryptJson<Partial<AnalyzeResult>>(raw.enc, udk));
    // legacy plaintext cache — migrate into the owner's key
    const legacy = validResult(raw as Partial<AnalyzeResult>);
    if (legacy) await writeAnalyzeCache(key, legacy, udk);
    return legacy;
  } catch {
    return null;
  }
}

export async function writeAnalyzeCache(key: string, result: AnalyzeResult, udk: Buffer): Promise<void> {
  await enqueue(key, async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeAtomic(CACHE_DIR + key + '.json', JSON.stringify({ enc: encryptJson(result, udk) }));
  });
}

/** Ops: drop analyze caches — one owner's (account purge) or every one (cache clear).
 *  Purely derived data; recomputed on demand while the owner's key is present. */
export async function clearAnalyzeCaches(ownerId?: string): Promise<number> {
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
    await enqueue(f.slice(0, -'.json'.length), () => rm(CACHE_DIR + f, { force: true }));
    removed++;
  }
  return removed;
}

/** Login-triggered sweep: rewrite an owner's plaintext analyze caches as envelopes. */
export async function migrateLegacyAnalyzeCaches(ownerId: string, udk: Buffer): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(`${ownerId}-`) || !f.endsWith('.json')) continue;
    // readAnalyzeCache re-encrypts legacy plaintext in place
    await readAnalyzeCache(f.slice(0, -'.json'.length), udk).catch(() => null);
  }
}

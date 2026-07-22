/** PUBLIC STUB — the real face pipeline (SCRFD detection, ArcFace embeddings, alignment,
 *  greedy matching, incremental clustering) lives in the private core module.
 *
 *  What remains real here is the encrypted cache housekeeping: purge (ops/purge.ts),
 *  family-key rotation (v1/familyRoutes.ts) and thumb-cache serving call these
 *  unconditionally, so they must keep working even when inference itself is absent.
 *  Every ML entry point throws; all its call sites are gated behind INFERENCE_DISABLED=1
 *  or wrapped in a .catch(...), so the process never crashes. */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './lib/atomicFile.ts';
import {
  decryptBuffer,
  decryptJson,
  encryptBuffer,
  encryptJson,
  isEncryptedBuffer,
  isEnvelope,
} from './crypto.ts';
import * as store from './store.ts';
import * as people from './people.ts';

const MODEL_VERSION = 'buffalo_l-2';

const local = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const CACHE_DIR = local('../cache/face/');
const THUMB_DIR = local('../cache/faceThumb/');

export interface FaceDetection {
  bbox: number[]; // [x1,y1,x2,y2] in original image coords
  score: number;
  kps: number[]; // 5 landmarks, [x0,y0,...,x4,y4]
  embedding: number[]; // L2-normalized, 512-d
}

type UnassignedCluster = { faces: { entryId: string; faceIndex: number }[] };

const UNAVAILABLE = 'face recognition is part of the private core module — not available in this build';

// ---------- ML pipeline: private core only ----------

export function prewarmFace(): void {
  throw new Error(UNAVAILABLE);
}

export async function detectFaces(
  input: Buffer,
  scopeId: string,
  scopeKey: Buffer,
): Promise<FaceDetection[]> {
  void input; void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

export function matchPeople(
  faces: FaceDetection[],
  registry: people.Person[],
): { people: store.PersonRef[]; unknownFaces: number } {
  void faces; void registry;
  throw new Error(UNAVAILABLE);
}

export async function scanEntry(
  entryId: string,
  image: Buffer,
  scopeId: string,
  scopeKey: Buffer,
): Promise<void> {
  void entryId; void image; void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

export async function rescanEntries(entryIds: string[], scopeId: string, scopeKey: Buffer): Promise<void> {
  void entryIds; void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

export async function rescanScope(scopeId: string, scopeKey: Buffer): Promise<void> {
  void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

export function scheduleRescan(scopeId: string, scopeKey: Buffer): void {
  void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

export async function embeddingFor(
  entryId: string,
  faceIndex: number,
  scopeId: string,
  scopeKey: Buffer,
  ownerUdk: Buffer | undefined,
): Promise<number[] | null> {
  void entryId; void faceIndex; void scopeId; void scopeKey; void ownerUdk;
  throw new Error(UNAVAILABLE);
}

export async function unassignedClusters(
  scopeId: string,
  scopeKey: Buffer,
): Promise<UnassignedCluster[]> {
  void scopeId; void scopeKey;
  throw new Error(UNAVAILABLE);
}

/** Cache miss needs the real pipeline to align/crop the face — core only. */
export async function faceThumb(
  entryId: string,
  faceIndex: number,
  scopeId: string,
  scopeKey: Buffer,
  ownerUdk: Buffer | undefined,
): Promise<Buffer | null> {
  void entryId; void faceIndex; void scopeId; void scopeKey; void ownerUdk;
  throw new Error(UNAVAILABLE);
}

// ---------- encrypted cache housekeeping: kept real ----------
// Embeddings are biometric data: cached per scope (family/personal) under the
// scope key, filenames `<scopeId>-<imageHash>.json`. Legacy bare-hash plaintext
// caches are opportunistically re-encrypted into the new key on first read.

interface FaceCache {
  v: string;
  faces: FaceDetection[];
}

function validFaces(cached: Partial<FaceCache>): FaceDetection[] | null {
  if (cached.v !== MODEL_VERSION || !Array.isArray(cached.faces)) return null;
  return cached.faces.filter((face) =>
    Array.isArray(face?.bbox) && face.bbox.length === 4 &&
    Array.isArray(face?.kps) && face.kps.length === 10 &&
    Array.isArray(face?.embedding) && face.embedding.length > 0 &&
    face.bbox.every(Number.isFinite) && face.kps.every(Number.isFinite) &&
    face.embedding.every(Number.isFinite),
  ) as FaceDetection[];
}

async function writeFaceCache(scopeId: string, imageHash: string, scopeKey: Buffer, cache: FaceCache): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeAtomic(
    CACHE_DIR + `${scopeId}-${imageHash}.json`,
    JSON.stringify({ enc: encryptJson(cache, scopeKey) }),
  );
}

/** Cache-only read — no image bytes needed. Migrates legacy bare-hash plaintext files. */
export async function readFaceCache(
  scopeId: string,
  imageHash: string,
  scopeKey: Buffer,
): Promise<FaceDetection[] | null> {
  if (!imageHash) return null;
  try {
    const raw = JSON.parse(await readFile(CACHE_DIR + `${scopeId}-${imageHash}.json`, 'utf8')) as Record<string, unknown>;
    if (isEnvelope(raw.enc)) {
      const faces = validFaces(decryptJson<Partial<FaceCache>>(raw.enc, scopeKey));
      if (faces) return faces;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const legacyPath = CACHE_DIR + imageHash + '.json';
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as Partial<FaceCache>;
    const faces = validFaces(legacy);
    if (faces) {
      await writeFaceCache(scopeId, imageHash, scopeKey, { v: MODEL_VERSION, faces });
      await rm(legacyPath, { force: true });
      return faces;
    }
  } catch {
    // cache miss
  }
  return null;
}

/** Cache-only thumb read — no image bytes needed, so the route can serve hits
 *  without queueing behind inference. Migrates legacy bare-hash plaintext thumbs. */
export async function readFaceThumbCache(
  entryId: string,
  faceIndex: number,
  scopeId: string,
  scopeKey: Buffer,
): Promise<Buffer | null> {
  const entry = await store.getEntry(entryId);
  if (!entry?.imageHash) return null;
  const file = THUMB_DIR + `${scopeId}-${entry.imageHash}-${faceIndex}.jpg`;
  try {
    const buf = await readFile(file);
    return isEncryptedBuffer(buf) ? decryptBuffer(buf, scopeKey) : buf;
  } catch {
    // cache miss
  }
  // legacy plaintext thumb keyed by bare hash — migrate into the scoped key
  try {
    const legacyPath = THUMB_DIR + `${entry.imageHash}-${faceIndex}.jpg`;
    const legacy = await readFile(legacyPath);
    if (!isEncryptedBuffer(legacy)) {
      await mkdir(THUMB_DIR, { recursive: true });
      await writeAtomic(file, encryptBuffer(legacy, scopeKey));
      await rm(legacyPath, { force: true });
      return legacy;
    }
  } catch {
    // no legacy thumb either
  }
  return null;
}

/** Family-key rotation: re-encrypt every cached artifact of a scope under a new key. */
export async function reencryptScopeCaches(
  scopeId: string,
  oldKey: Buffer,
  newKey: Buffer,
): Promise<void> {
  const prefix = `${scopeId}-`;
  for (const [dir, binary] of [[CACHE_DIR, false], [THUMB_DIR, true]] as const) {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      try {
        const raw = await readFile(dir + f);
        if (binary) {
          if (!isEncryptedBuffer(raw)) continue;
          await writeAtomic(dir + f, encryptBuffer(decryptBuffer(raw, oldKey), newKey));
        } else {
          const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (!isEnvelope(parsed.enc)) continue;
          await writeAtomic(
            dir + f,
            JSON.stringify({ enc: encryptJson(decryptJson(parsed.enc, oldKey), newKey) }),
          );
        }
      } catch (e) {
        // an unreadable cache entry is disposable — drop it rather than leave old-key data
        console.warn('[face] cache rotation dropped', f, e);
        await rm(dir + f, { force: true });
      }
    }
  }
}

/** Ops purge / family dissolution: drop every cached face artifact of one scope. */
export async function deleteScopeCaches(scopeId: string): Promise<void> {
  const prefix = `${scopeId}-`;
  for (const dir of [CACHE_DIR, THUMB_DIR]) {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith(prefix)) await rm(dir + f, { force: true });
    }
  }
}

/** Login-triggered sweep: adopt legacy bare-hash plaintext face thumbs into the scope key. */
export async function migrateLegacyThumbs(
  imageHash: string,
  scopeId: string,
  scopeKey: Buffer,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(imageHash)) return;
  let files: string[] = [];
  try {
    files = await readdir(THUMB_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(`${imageHash}-`) || !f.endsWith('.jpg')) continue;
    try {
      const legacy = await readFile(THUMB_DIR + f);
      if (isEncryptedBuffer(legacy)) continue;
      await writeAtomic(THUMB_DIR + `${scopeId}-${f}`, encryptBuffer(legacy, scopeKey));
      await rm(THUMB_DIR + f, { force: true });
    } catch {
      // skip
    }
  }
}

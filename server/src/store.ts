/** File-backed entry store: data/entries/<id>.json + .img + .thumb.
 *  Personal scale — the whole index lives in memory, writes go straight to disk.
 *  At rest, sensitive content ({title, mood, diaryText, imageDescription, chat})
 *  lives in an AES-GCM envelope (`enc`) keyed by the owner's UDK, and the JPEG
 *  blobs are framed ciphertext. The in-memory index never holds decrypted
 *  content — structural fields stay plaintext for boot-time indexing; decryption
 *  happens per call with the key the (authenticated) caller supplies. Legacy
 *  plaintext rows (`enc` absent) read as-is until the lazy migration rewrites them. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import {
  decryptBuffer,
  decryptJson,
  encryptBuffer,
  encryptJson,
  isEncryptedBuffer,
  isEnvelope,
  type Envelope,
} from './crypto.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PersonRef {
  personId: string;
  faceIndex: number;
}

export type DateSource = 'exif' | 'filename' | 'file' | 'now' | 'manual' | 'chat';

export interface EntryMeta {
  id: string;
  /** Memory/event time — timeline sort & diary date. Kept in sync with takenAt. */
  createdAt: number;
  /** Canonical memory time. */
  takenAt: number;
  /** Upload wall-clock time. */
  uploadedAt: number;
  dateSource: DateSource;
  yearMonth: string;
  status: 'new' | 'chatting' | 'done';
  title: string;
  mood: string;
  diaryText: string;
  imageDescription: string;
  chat: ChatMessage[];
  /**
   * Owner of this memory (auth account id). Canonical isolation field for v1.
   * Kept in sync with userId for legacy /api routes.
   */
  ownerId: string;
  /** @deprecated alias of ownerId — last person who chatted/wrote this entry */
  userId: string;
  /** Tenancy scope for shared features (faces/people). null = personal scope. */
  familyId: string | null;
  /** sha256 of the plaintext image — cache key for face/depth without decrypting. */
  imageHash: string;
  people: PersonRef[];
  unknownFaces: number;
  faceScannedAt: number;
  relationScannedAt: number;
}

/** Scope key namespace for this entry's face/people features. */
export function entryScopeId(entry: Pick<EntryMeta, 'familyId' | 'ownerId' | 'userId'>): string {
  return entry.familyId ?? (entry.ownerId || entry.userId);
}

export interface ListEntriesQuery {
  ownerId?: string;
  status?: EntryMeta['status'];
  yearMonth?: string;
  /** opaque cursor from a previous page; sort is takenAt desc, id desc */
  cursor?: string;
  limit?: number;
}

export interface ListEntriesResult {
  items: EntryMeta[];
  nextCursor: string | null;
}

const DIR = fileURLToPath(new URL('../data/entries/', import.meta.url));
// ids go into file paths — reject anything that could traverse
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_SOURCES = new Set<DateSource>([
  'exif',
  'filename',
  'file',
  'now',
  'manual',
  'chat',
]);
const MAX_CHAT_MESSAGES = 64;
const MAX_CHAT_CONTENT = 4000;
const MAX_TEXT = 20_000;

/** On-disk / in-memory record: meta has EMPTY content fields when `enc` is set. */
interface StoredEntry {
  meta: EntryMeta;
  enc: Envelope | null;
}

let index: Map<string, StoredEntry> | null = null;
let indexLoad: Promise<Map<string, StoredEntry>> | null = null;

const entryQueue = createKeyedQueue();
const monthlyQueue = createKeyedQueue();

export const validId = (id: string): boolean => ID_RE.test(id);

export const hashImage = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const nonNegative = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function toYearMonth(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDateSource(v: unknown): DateSource {
  return typeof v === 'string' && DATE_SOURCES.has(v as DateSource)
    ? (v as DateSource)
    : 'now';
}

/** coerce untrusted client JSON into a well-formed meta */
export function sanitizeMeta(raw: Record<string, unknown>): EntryMeta {
  const status = raw.status;
  const now = Date.now();
  // takenAt is canonical; createdAt is the legacy alias — prefer explicit takenAt
  const takenAt = numOr(raw.takenAt, numOr(raw.createdAt, now));
  const createdAt = takenAt;
  const uploadedAt = numOr(raw.uploadedAt, takenAt);
  // ownerId is canonical; userId is the legacy alias — accept either, dual-write both
  const owner = str(raw.ownerId).slice(0, 64) || str(raw.userId).slice(0, 64);

  return {
    id: str(raw.id),
    createdAt,
    takenAt,
    uploadedAt,
    dateSource: parseDateSource(raw.dateSource),
    yearMonth: toYearMonth(takenAt),
    status: status === 'chatting' || status === 'done' ? status : 'new',
    title: str(raw.title).slice(0, 200),
    mood: str(raw.mood).slice(0, 40),
    diaryText: str(raw.diaryText).slice(0, MAX_TEXT),
    imageDescription: str(raw.imageDescription).slice(0, 12_000),
    chat: Array.isArray(raw.chat)
      ? raw.chat.slice(-MAX_CHAT_MESSAGES).map((m: { role?: unknown; content?: unknown }) => ({
          role: m?.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: str(m?.content).slice(0, MAX_CHAT_CONTENT),
        }))
      : [],
    ownerId: owner,
    userId: owner,
    familyId:
      typeof raw.familyId === 'string' && ID_RE.test(raw.familyId) ? raw.familyId : null,
    imageHash: /^[a-f0-9]{64}$/.test(str(raw.imageHash)) ? str(raw.imageHash) : '',
    people: Array.isArray(raw.people)
      ? raw.people.slice(0, 20).map((p: { personId?: unknown; faceIndex?: unknown }) => ({
          personId: str(p?.personId),
          faceIndex: Math.max(0, Math.min(19, Number(p?.faceIndex) || 0)),
        }))
      : [],
    unknownFaces: Math.max(0, Math.min(20, Math.floor(nonNegative(raw.unknownFaces)))),
    faceScannedAt: nonNegative(raw.faceScannedAt),
    relationScannedAt: nonNegative(raw.relationScannedAt),
  };
}

// ---------- content envelope helpers ----------

interface EntryContent {
  title: string;
  mood: string;
  diaryText: string;
  imageDescription: string;
  chat: ChatMessage[];
}

const CONTENT_KEYS = ['title', 'mood', 'diaryText', 'imageDescription', 'chat'] as const;

function pickContent(meta: EntryMeta): EntryContent {
  return {
    title: meta.title,
    mood: meta.mood,
    diaryText: meta.diaryText,
    imageDescription: meta.imageDescription,
    chat: meta.chat,
  };
}

function blankContent(meta: EntryMeta): EntryMeta {
  return { ...meta, title: '', mood: '', diaryText: '', imageDescription: '', chat: [] };
}

function toStored(full: EntryMeta, udk: Buffer): StoredEntry {
  return { meta: blankContent(full), enc: encryptJson(pickContent(full), udk) };
}

function diskJson(stored: StoredEntry): string {
  if (!stored.enc) return JSON.stringify(stored.meta);
  const { title: _t, mood: _m, diaryText: _d, imageDescription: _i, chat: _c, ...structural } =
    stored.meta;
  return JSON.stringify({ ...structural, enc: stored.enc });
}

function parseStored(raw: Record<string, unknown>): StoredEntry {
  const enc = isEnvelope(raw.enc) ? raw.enc : null;
  const meta = sanitizeMeta(raw);
  return enc ? { meta: blankContent(meta), enc } : { meta, enc: null };
}

class KeysMissingError extends Error {
  status = 423;
  constructor() {
    super('entry content locked — owner key unavailable');
  }
}

/** Full meta with content. Legacy rows need no key; encrypted rows need the owner UDK. */
function decryptStored(stored: StoredEntry, udk: Buffer | undefined): EntryMeta {
  if (!stored.enc) return stored.meta;
  if (!udk) throw new KeysMissingError();
  const content = decryptJson<EntryContent>(stored.enc, udk);
  return sanitizeMeta({ ...stored.meta, ...content });
}

function encodeCursor(takenAt: number, id: string): string {
  return Buffer.from(`${takenAt}:${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { takenAt: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = raw.indexOf(':');
    if (i <= 0) return null;
    const takenAt = Number(raw.slice(0, i));
    const id = raw.slice(i + 1);
    if (!Number.isFinite(takenAt) || !validId(id)) return null;
    return { takenAt, id };
  } catch {
    return null;
  }
}

/** Sort key: newer first; tie-break by id desc for stable pagination. */
function entrySortKey(a: EntryMeta, b: EntryMeta): number {
  const ta = a.takenAt || a.createdAt;
  const tb = b.takenAt || b.createdAt;
  if (tb !== ta) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

interface FileReplacement {
  path: string;
  data: string | Uint8Array;
}

interface ReplacementState extends FileReplacement {
  temp: string;
  backup: string;
  hadOld: boolean;
  installed: boolean;
}

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

async function removeBestEffort(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Stage every file first, then replace the old files under one caller-owned
 * record lock. If a replacement fails, restore any old files already moved.
 * Readers therefore see either the old complete file or the new complete file,
 * never a partially written JSON/blob.
 */
async function replaceFiles(files: FileReplacement[]): Promise<void> {
  if (!files.length) return;
  await mkdir(DIR, { recursive: true });
  const token = `${process.pid}.${randomUUID()}`;
  const states: ReplacementState[] = files.map((file) => ({
    ...file,
    temp: `${file.path}.${token}.tmp`,
    backup: `${file.path}.${token}.bak`,
    hadOld: false,
    installed: false,
  }));
  const moved: ReplacementState[] = [];
  const installed: ReplacementState[] = [];
  let committed = false;

  try {
    for (const state of states) await writeFile(state.temp, state.data);

    try {
      for (const state of states) {
        try {
          await rename(state.path, state.backup);
          state.hadOld = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        moved.push(state);
        await rename(state.temp, state.path);
        state.installed = true;
        installed.push(state);
      }
      committed = true;
    } catch (error) {
      // Roll back in reverse order. A failed restore is logged and its backup
      // is intentionally retained so the old data is still recoverable.
      for (const state of [...installed].reverse()) {
        await removeBestEffort(state.path);
      }
      for (const state of [...moved].reverse()) {
        if (!state.hadOld) continue;
        try {
          await rename(state.backup, state.path);
        } catch (restoreError) {
          console.error('[store] failed to restore', state.path, restoreError);
        }
      }
      throw error;
    }
  } finally {
    for (const state of states) await removeBestEffort(state.temp);
    if (committed) {
      // Cleanup is deliberately best effort: replacement is already complete,
      // and a leftover backup is safer than deleting the only old copy.
      for (const state of states) await removeBestEffort(state.backup);
    } else {
      // Backups for files with no old version should never exist, but clean
      // them if a previous interrupted attempt left one behind.
      for (const state of states) {
        if (!state.hadOld) await removeBestEffort(state.backup);
      }
    }
  }
}

/** Move all entry files aside before deleting them, allowing rollback on a
 * rename failure. The moved backups are removed only after every rename wins. */
async function removeFilesAtomically(paths: string[]): Promise<void> {
  const token = `${process.pid}.${randomUUID()}`;
  const moved: { path: string; backup: string }[] = [];
  let committed = false;
  try {
    for (const path of paths) {
      const backup = `${path}.${token}.bak`;
      try {
        await rename(path, backup);
        moved.push({ path, backup });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    committed = true;
  } catch (error) {
    for (const item of [...moved].reverse()) {
      try {
        await rename(item.backup, item.path);
      } catch (restoreError) {
        console.error('[store] failed to restore deleted file', item.path, restoreError);
      }
    }
    throw error;
  } finally {
    if (committed) {
      for (const item of moved) await removeBestEffort(item.backup);
    }
  }
}

async function load(): Promise<Map<string, StoredEntry>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, StoredEntry>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          // sanitize on load so entries written before newer fields existed read back complete
          const stored = parseStored(JSON.parse(await readFile(DIR + f, 'utf8')) as Record<string, unknown>);
          if (!validId(stored.meta.id) || stored.meta.id !== f.slice(0, -'.json'.length)) {
            console.warn('[store] skipping entry with invalid id', f);
            continue;
          }
          map.set(stored.meta.id, stored);
        } catch {
          console.warn('[store] skipping corrupt meta', f);
        }
      }
      index = map;
      return map;
    })();
  }
  try {
    return await indexLoad;
  } catch (error) {
    indexLoad = null;
    throw error;
  }
}

/** Structural view: content fields are EMPTY for encrypted rows. */
export async function listEntries(): Promise<EntryMeta[]> {
  return [...(await load()).values()].map((s) => s.meta).sort(entrySortKey);
}

/** Owner's entries with decrypted content (legacy rows pass through). */
export async function listEntriesFor(ownerId: string, udk: Buffer | undefined): Promise<EntryMeta[]> {
  const rows = [...(await load()).values()]
    .filter((s) => s.meta.ownerId === ownerId || s.meta.userId === ownerId)
    .sort((a, b) => entrySortKey(a.meta, b.meta));
  return rows.map((s) => decryptStored(s, udk));
}

/** ids of rows not yet rewritten into the encrypted shape */
export async function listLegacyEntryIds(ownerId?: string): Promise<string[]> {
  return [...(await load()).values()]
    .filter((s) => !s.enc && (!ownerId || s.meta.ownerId === ownerId || s.meta.userId === ownerId))
    .map((s) => s.meta.id);
}

/** Filtered + cursor-paginated list (v1), content decrypted with the owner's key. */
export async function listEntriesPage(
  query: ListEntriesQuery = {},
  udk?: Buffer,
): Promise<ListEntriesResult> {
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 50)));
  let rows = [...(await load()).values()];
  if (query.ownerId)
    rows = rows.filter((s) => s.meta.ownerId === query.ownerId || s.meta.userId === query.ownerId);
  if (query.status) rows = rows.filter((s) => s.meta.status === query.status);
  if (query.yearMonth && validYearMonth(query.yearMonth))
    rows = rows.filter((s) => s.meta.yearMonth === query.yearMonth);
  rows.sort((a, b) => entrySortKey(a.meta, b.meta));

  if (query.cursor) {
    const cur = decodeCursor(query.cursor);
    if (cur) {
      rows = rows.filter((s) => {
        const t = s.meta.takenAt || s.meta.createdAt;
        if (t < cur.takenAt) return true;
        if (t > cur.takenAt) return false;
        return s.meta.id < cur.id;
      });
    }
  }

  const page = rows.slice(0, limit).map((s) => decryptStored(s, udk));
  const last = page[page.length - 1];
  const nextCursor =
    page.length === limit && last ? encodeCursor(last.takenAt || last.createdAt, last.id) : null;
  return { items: page, nextCursor };
}

/** Structural view (content empty for encrypted rows) — ownership checks, indexes. */
export async function getEntry(id: string): Promise<EntryMeta | undefined> {
  return (await load()).get(id)?.meta;
}

/** Full meta with content — every caller that reads title/diary/chat uses this. */
export async function getEntryDecrypted(
  id: string,
  udk: Buffer | undefined,
): Promise<EntryMeta | undefined> {
  const stored = (await load()).get(id);
  return stored ? decryptStored(stored, udk) : undefined;
}

/** Entry is visible to user only when they own it. */
export function isOwnedBy(entry: EntryMeta | undefined, userId: string): entry is EntryMeta {
  if (!entry || !userId) return false;
  return entry.ownerId === userId || entry.userId === userId;
}

/**
 * Create one entry under its record lock. The boolean result is decided while
 * holding that lock, so two concurrent uploads with the same id cannot both
 * pass an outside existence check and overwrite the first upload.
 * Blobs and content are encrypted with the owner's UDK before touching disk.
 */
export async function putEntry(
  meta: EntryMeta,
  image: Buffer,
  thumb: Buffer,
  udk: Buffer,
): Promise<boolean> {
  const id = meta.id;
  const full = sanitizeMeta({ ...meta, imageHash: hashImage(image) } as unknown as Record<string, unknown>);
  const stored = toStored(full, udk);
  const metaJson = diskJson(stored);
  const encImage = encryptBuffer(image, udk);
  const encThumb = encryptBuffer(thumb, udk);
  return entryQueue(id, async () => {
    const map = await load();
    if (map.has(id)) return false;
    await replaceFiles([
      { path: DIR + id + '.img', data: encImage },
      { path: DIR + id + '.thumb', data: encThumb },
      { path: DIR + id + '.json', data: metaJson },
    ]);
    map.set(id, parseStored(JSON.parse(metaJson) as Record<string, unknown>));
    return true;
  });
}

const STRUCTURAL_PATCH_KEYS = new Set([
  'takenAt',
  'createdAt',
  'uploadedAt',
  'dateSource',
  'status',
  'ownerId',
  'userId',
  'familyId',
  'imageHash',
  'people',
  'unknownFaces',
  'faceScannedAt',
  'relationScannedAt',
]);

/** Structural-only patch — works without any key (face scan markers, migrations).
 *  Content fields are rejected here; use patchEntryContent for those. */
export async function patchEntry(
  id: string,
  patch: Record<string, unknown>,
): Promise<EntryMeta | undefined> {
  const illegal = Object.keys(patch).filter((k) => !STRUCTURAL_PATCH_KEYS.has(k));
  if (illegal.length) throw new Error(`patchEntry got content fields: ${illegal.join(', ')}`);
  const patchCopy = { ...patch };
  return entryQueue(id, async () => {
    const map = await load();
    const cur = map.get(id);
    if (!cur) return undefined;
    const nextMeta = sanitizeMeta({ ...cur.meta, ...patchCopy, id });
    const next: StoredEntry = cur.enc
      ? { meta: blankContent(nextMeta), enc: cur.enc }
      : { meta: nextMeta, enc: null };
    await writeAtomic(DIR + id + '.json', diskJson(next));
    map.set(id, next);
    return next.meta;
  });
}

/** Mixed patch that may touch content — requires the owner's UDK.
 *  Legacy rows are opportunistically rewritten into the encrypted shape. */
export async function patchEntryContent(
  id: string,
  patch: Record<string, unknown>,
  udk: Buffer,
): Promise<EntryMeta | undefined> {
  return updateEntryContent(id, udk, () => patch);
}

/** Read-modify-write with decrypted content under the per-entry queue (safe chat append). */
export async function updateEntryContent(
  id: string,
  udk: Buffer,
  mutator: (cur: EntryMeta) => EntryMeta | Record<string, unknown> | null | undefined,
): Promise<EntryMeta | undefined> {
  return entryQueue(id, async () => {
    const map = await load();
    const cur = map.get(id);
    if (!cur) return undefined;
    const full = decryptStored(cur, udk);
    const patch = mutator(full);
    if (patch == null) return full;
    const nextFull = sanitizeMeta({ ...full, ...patch, id });
    const next = toStored(nextFull, udk);
    await writeAtomic(DIR + id + '.json', diskJson(next));
    map.set(id, next);
    return nextFull;
  });
}

/** Lazy at-rest migration of one legacy row: encrypt content + blobs, set imageHash. */
export async function encryptEntryRecord(id: string, udk: Buffer): Promise<boolean> {
  return entryQueue(id, async () => {
    const map = await load();
    const cur = map.get(id);
    if (!cur || cur.enc) return false;
    const files: FileReplacement[] = [];
    let imageHash = cur.meta.imageHash;
    for (const kind of ['img', 'thumb'] as const) {
      try {
        const blob = await readFile(DIR + id + '.' + kind);
        if (!isEncryptedBuffer(blob)) {
          if (kind === 'img') imageHash = hashImage(blob);
          files.push({ path: DIR + id + '.' + kind, data: encryptBuffer(blob, udk) });
        }
      } catch {
        // missing blob — meta rewrite still proceeds
      }
    }
    const nextFull = sanitizeMeta({ ...cur.meta, imageHash, id });
    const next = toStored(nextFull, udk);
    files.push({ path: DIR + id + '.json', data: diskJson(next) });
    await replaceFiles(files);
    map.set(id, next);
    return true;
  });
}

/** Rewrite person refs on every entry: merge (targetId set) or delete (undefined). */
export async function rewritePersonRefs(fromId: string, targetId?: string): Promise<void> {
  // Snapshot only decides which entries to touch; the actual rewrite recomputes
  // from the current people[] inside the per-entry lock so a concurrent face scan
  // or another rewrite on the same entry can't be clobbered by a stale snapshot.
  for (const snapshot of await listEntries()) {
    if (!snapshot.people.some((ref) => ref.personId === fromId)) continue;
    await entryQueue(snapshot.id, async () => {
      const map = await load();
      const cur = map.get(snapshot.id);
      if (!cur || !cur.meta.people.some((ref) => ref.personId === fromId)) return;
      const next = cur.meta.people.flatMap((ref) => {
        if (ref.personId !== fromId) return [ref];
        return targetId ? [{ ...ref, personId: targetId }] : [];
      });
      const deduped = next.filter(
        (ref, i, all) =>
          all.findIndex(
            (candidate) =>
              candidate.personId === ref.personId && candidate.faceIndex === ref.faceIndex,
          ) === i,
      );
      const nextStored: StoredEntry = {
        meta: sanitizeMeta({ ...cur.meta, people: deduped, id: cur.meta.id }),
        enc: cur.enc,
      };
      if (cur.enc) nextStored.meta = blankContent(nextStored.meta);
      await writeAtomic(DIR + cur.meta.id + '.json', diskJson(nextStored));
      map.set(cur.meta.id, nextStored);
    });
  }
}

export async function deleteEntry(id: string): Promise<boolean> {
  return entryQueue(id, async () => {
    const map = await load();
    if (!map.has(id)) return false;
    await removeFilesAtomically(['.json', '.img', '.thumb'].map((ext) => DIR + id + ext));
    map.delete(id);
    return true;
  });
}

/** Ops: total on-disk bytes of one owner's entry files (json + blobs). */
export async function ownerStorageBytes(ownerId: string): Promise<number> {
  let total = 0;
  for (const entry of await listEntries()) {
    if (entry.ownerId !== ownerId && entry.userId !== ownerId) continue;
    for (const ext of ['.json', '.img', '.thumb'] as const) {
      try {
        total += (await stat(DIR + entry.id + ext)).size;
      } catch {
        // blob missing
      }
    }
  }
  return total;
}

/** Ops purge: every entry (json + blobs) and monthly review owned by one account. */
export async function deleteOwnerData(ownerId: string): Promise<number> {
  let removed = 0;
  for (const entry of await listEntries()) {
    if (entry.ownerId !== ownerId && entry.userId !== ownerId) continue;
    if (await deleteEntry(entry.id)) removed++;
  }
  let monthlyFiles: string[] = [];
  try {
    monthlyFiles = await readdir(MONTHLY_DIR);
  } catch {
    return removed;
  }
  for (const f of monthlyFiles) {
    if (!f.endsWith(`-${ownerId}.json`)) continue;
    const key = f.slice(0, -'.json'.length);
    if (!MONTHLY_KEY_RE.test(key)) continue;
    await monthlyQueue(key, () => rm(MONTHLY_DIR + f, { force: true }));
  }
  return removed;
}

/** Blob bytes, decrypted when framed. Encrypted blob without a key → null
 *  (treated as unavailable — the unlock flow is the recovery path). */
export async function readEntryBlob(
  id: string,
  kind: 'img' | 'thumb',
  udk?: Buffer,
): Promise<Buffer | null> {
  try {
    const buf = await readFile(DIR + id + '.' + kind);
    if (!isEncryptedBuffer(buf)) return buf;
    if (!udk) return null;
    return decryptBuffer(buf, udk);
  } catch {
    return null;
  }
}

// ---------- monthly reviews: one json per <yearMonth>-<userId> key ----------

export interface MonthlyReview {
  yearMonth: string;
  text: string;
  generatedAt: number;
}

function sanitizeMonthlyReview(raw: unknown): MonthlyReview | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.yearMonth !== 'string' || !validYearMonth(value.yearMonth)) return undefined;
  if (typeof value.text !== 'string') return undefined;
  const generatedAt = Number(value.generatedAt);
  return {
    yearMonth: value.yearMonth,
    text: value.text.slice(0, 100_000),
    generatedAt: Number.isFinite(generatedAt) && generatedAt > 0 ? generatedAt : 0,
  };
}

const MONTHLY_DIR = fileURLToPath(new URL('../data/monthly/', import.meta.url));
const MONTHLY_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-[A-Za-z0-9-]{1,64}$/;

export const validYearMonth = (ym: string): boolean => {
  if (!/^\d{4}-\d{2}$/.test(ym)) return false;
  const month = Number(ym.slice(5));
  return month >= 1 && month <= 12;
};

export async function getMonthlyReview(
  key: string,
  udk: Buffer | undefined,
): Promise<MonthlyReview | undefined> {
  if (!MONTHLY_KEY_RE.test(key)) return undefined;
  try {
    const raw = JSON.parse(await readFile(MONTHLY_DIR + key + '.json', 'utf8')) as Record<string, unknown>;
    if (isEnvelope(raw.enc)) {
      if (!udk) return undefined;
      return sanitizeMonthlyReview({ ...raw, ...decryptJson<{ text: string }>(raw.enc, udk) });
    }
    return sanitizeMonthlyReview(raw);
  } catch {
    return undefined;
  }
}

export async function putMonthlyReview(
  key: string,
  review: MonthlyReview,
  udk: Buffer,
): Promise<void> {
  if (!MONTHLY_KEY_RE.test(key)) throw new Error('invalid monthly review key');
  const safe = sanitizeMonthlyReview(review);
  if (!safe) throw new Error('invalid monthly review');
  const reviewJson = JSON.stringify({
    yearMonth: safe.yearMonth,
    generatedAt: safe.generatedAt,
    enc: encryptJson({ text: safe.text }, udk),
  });
  await monthlyQueue(key, async () => {
    await mkdir(MONTHLY_DIR, { recursive: true });
    await writeAtomic(MONTHLY_DIR + key + '.json', reviewJson);
  });
}

/** Lazy migration: rewrite an owner's plaintext monthly reviews as envelopes. */
export async function encryptMonthlyReviews(userId: string, udk: Buffer): Promise<number> {
  let rewritten = 0;
  let files: string[] = [];
  try {
    files = await readdir(MONTHLY_DIR);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(`-${userId}.json`)) continue;
    const key = f.slice(0, -'.json'.length);
    if (!MONTHLY_KEY_RE.test(key)) continue;
    await monthlyQueue(key, async () => {
      try {
        const raw = JSON.parse(await readFile(MONTHLY_DIR + f, 'utf8')) as Record<string, unknown>;
        if (isEnvelope(raw.enc)) return;
        const safe = sanitizeMonthlyReview(raw);
        if (!safe) return;
        await writeAtomic(
          MONTHLY_DIR + f,
          JSON.stringify({
            yearMonth: safe.yearMonth,
            generatedAt: safe.generatedAt,
            enc: encryptJson({ text: safe.text }, udk),
          }),
        );
        rewritten++;
      } catch {
        // skip corrupt file
      }
    });
  }
  return rewritten;
}

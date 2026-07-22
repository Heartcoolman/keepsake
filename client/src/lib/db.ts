/** Server-backed entry store via /api/v1 (auth required). */
import { create } from 'zustand';
import Dexie, { type Table } from 'dexie';
import { entryTakenAt, type Entry } from './types';
import { apiFetch, errorFromResponse } from './http';
import { mediaPath } from './media';

interface EntriesState {
  entries: Entry[];
  loaded: boolean;
  error: string | null;
  nextCursor: string | null;
}

export const useEntriesStore = create<EntriesState>(() => ({
  entries: [],
  loaded: false,
  error: null,
  nextCursor: null,
}));

export interface EntryRequestOptions {
  signal?: AbortSignal;
  userId?: string;
}

let refreshGeneration = 0;
let entriesViewUserId: string | undefined;

export function setEntriesViewUser(userId?: string): void {
  entriesViewUserId = userId || undefined;
  refreshGeneration++;
  useEntriesStore.setState({ entries: [], loaded: false, error: null, nextCursor: null });
}

function normalizeEntry(raw: Entry & { ownerId?: string }): Entry {
  const owner = raw.ownerId || raw.userId || '';
  return { ...raw, userId: owner, ownerId: owner } as Entry & { ownerId?: string };
}

export async function refreshEntries(options: EntryRequestOptions = {}): Promise<void> {
  const requestedUserId = options.userId || undefined;
  if (requestedUserId !== entriesViewUserId) return;
  const generation = ++refreshGeneration;
  try {
    // pull pages until done (personal scale); keep nextCursor for infinite scroll later
    const all: Entry[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const res = await apiFetch(`/api/v1/entries?${q}`, { signal: options.signal });
      if (generation !== refreshGeneration || requestedUserId !== entriesViewUserId) return;
      if (!res.ok) {
        useEntriesStore.setState({ loaded: true, error: `server:${res.status}` });
        return;
      }
      const page = (await res.json()) as { items: Entry[]; nextCursor: string | null };
      all.push(...page.items.map((e) => normalizeEntry(e)));
      cursor = page.nextCursor;
    } while (cursor);

    if (generation !== refreshGeneration || requestedUserId !== entriesViewUserId) return;
    useEntriesStore.setState({ entries: all, loaded: true, error: null, nextCursor: null });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (generation !== refreshGeneration || requestedUserId !== entriesViewUserId) return;
    useEntriesStore.setState({ loaded: true, error: 'network' });
  }
}

export async function getEntry(
  id: string,
  options: EntryRequestOptions = {},
): Promise<Entry | undefined> {
  try {
    const res = await apiFetch(`/api/v1/entries/${id}`, { signal: options.signal });
    return res.ok ? normalizeEntry((await res.json()) as Entry) : undefined;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}

export async function addEntry(
  entry: Entry,
  image: Blob,
  thumb: Blob,
  opts: { refresh?: boolean; clientUploadId?: string; override?: boolean } = {},
): Promise<void> {
  const form = new FormData();
  const meta = opts.clientUploadId ? { ...entry, clientUploadId: opts.clientUploadId } : entry;
  form.set('meta', JSON.stringify(meta));
  form.set('image', image, 'image.jpg');
  form.set('thumb', thumb, 'thumb.jpg');
  if (opts.override) form.set('override', '1');
  const res = await apiFetch('/api/v1/entries', { method: 'POST', body: form });
  // 200 (idempotent replay of clientUploadId) counts as success alongside 201.
  if (!res.ok) throw await errorFromResponse(res, 'add entry failed');
  // Batched callers (multi-file upload, legacy migration) refresh once at the end
  // instead of triggering a full re-fetch per entry.
  if (opts.refresh !== false) void refreshEntries({ userId: entry.userId });
}

export async function updateEntry(
  id: string,
  patch: Partial<Entry>,
  options: EntryRequestOptions = {},
): Promise<void> {
  const body = { ...patch };
  delete (body as { ownerId?: string }).ownerId;
  delete (body as { userId?: string }).userId;
  // The server derives yearMonth from takenAt and rejects it in the PATCH allow-list
  // (whole request 400s). Strip it from the wire body but keep it for the local merge
  // below so timeline/review month-grouping stays correct without a full refetch.
  const netBody = { ...body };
  delete (netBody as { yearMonth?: string }).yearMonth;
  const res = await apiFetch(`/api/v1/entries/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(netBody),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`update entry failed: ${res.status}`);
  // Merge the accepted patch locally instead of re-pulling every page; when the memory
  // date moved, restore the newest-first order the server would return.
  useEntriesStore.setState((s) => {
    const entries = s.entries.map((e) => (e.id === id ? { ...e, ...body } : e));
    if (body.takenAt !== undefined || body.createdAt !== undefined) {
      entries.sort((a, b) => entryTakenAt(b) - entryTakenAt(a));
    }
    return { entries };
  });
}

export async function deleteEntry(id: string, options: EntryRequestOptions = {}): Promise<void> {
  const res = await apiFetch(`/api/v1/entries/${id}`, {
    method: 'DELETE',
    signal: options.signal,
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete entry failed: ${res.status}`);
  await markLegacyDeleted(id);
  try {
    if (await Dexie.exists('nianxiang')) {
      const local = getLegacyDb();
      await local.entries.delete(id);
      await local.images.delete(id);
    }
  } catch {
    // legacy db unreadable
  }
  // Local removal is authoritative enough — no need to re-pull every page.
  useEntriesStore.setState((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
}

export async function getEntryImage(
  id: string,
  options: EntryRequestOptions = {},
): Promise<Blob | undefined> {
  try {
    const res = await apiFetch(mediaPath(id, 'image'), { signal: options.signal });
    return res.ok ? await res.blob() : undefined;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}

/** path for AuthImg — not a bare URL (needs Bearer) */
export const thumbUrl = (id: string): string => mediaPath(id, 'thumb');

// ---------- one-time migration of the old local-first IndexedDB ----------

type LegacyEntry = Entry & { thumbBlob?: Blob };
interface LegacyTombstone {
  id: string;
  deletedAt: number;
}

const TOMBSTONE_STORAGE_KEY = 'nianxiang:deleted-entry-ids';

class LegacyDB extends Dexie {
  entries!: Table<LegacyEntry, string>;
  images!: Table<{ entryId: string; blob: Blob }, string>;
  tombstones!: Table<LegacyTombstone, string>;

  constructor() {
    super('nianxiang');
    this.version(1).stores({
      entries: 'id, createdAt, yearMonth, status',
      images: 'entryId',
    });
    this.version(2).stores({
      entries: 'id, createdAt, yearMonth, status',
      images: 'entryId',
      tombstones: 'id, deletedAt',
    });
  }
}

/** Single shared connection — a new Dexie instance per call would leak IDB connections. */
let legacyDb: LegacyDB | null = null;
function getLegacyDb(): LegacyDB {
  legacyDb ??= new LegacyDB();
  return legacyDb;
}

function readStoredTombstones(): Set<string> {
  try {
    const raw = localStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function storeTombstones(ids: Set<string>): void {
  try {
    localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

async function markLegacyDeleted(id: string): Promise<void> {
  const ids = readStoredTombstones();
  ids.add(id);
  storeTombstones(ids);
  try {
    if (!(await Dexie.exists('nianxiang'))) return;
    await getLegacyDb().tombstones.put({ id, deletedAt: Date.now() });
  } catch {
    // ok
  }
}

async function loadLegacyTombstones(local?: LegacyDB): Promise<Set<string>> {
  const ids = readStoredTombstones();
  if (!local) return ids;
  try {
    const rows = await local.tombstones.toArray();
    for (const row of rows) ids.add(row.id);
  } catch {
    // ok
  }
  return ids;
}

export async function migrateLegacyData(currentUserId = ''): Promise<number> {
  let moved = 0;
  try {
    if (!(await Dexie.exists('nianxiang'))) return 0;
    const local = getLegacyDb();
    const tombstones = await loadLegacyTombstones(local);
    const rows = await local.entries.toArray();
    if (!rows.length) return 0;
    // Dedupe against the FULL server library — stopping at the first page would
    // re-upload legacy entries that live on later pages.
    const have = new Set<string>();
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const res = await apiFetch(`/api/v1/entries?${q}`);
      if (!res.ok) return 0;
      const page = (await res.json()) as { items: Entry[]; nextCursor: string | null };
      for (const item of page.items) have.add(item.id);
      cursor = page.nextCursor;
    } while (cursor);
    for (const row of rows) {
      if (tombstones.has(row.id)) continue;
      if (have.has(row.id)) continue;
      const image = (await local.images.get(row.id))?.blob;
      const { thumbBlob, ...meta } = row;
      if (!image || !thumbBlob) continue;
      const hasOwner = typeof meta.userId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(meta.userId);
      const migrated = hasOwner ? meta : { ...meta, userId: currentUserId };
      try {
        // onAuthed refreshes once after migration finishes — avoid a refresh per row.
        await addEntry(migrated, image, thumbBlob, { refresh: false });
        moved++;
      } catch (error) {
        console.warn('[migrate] skipped legacy entry', row.id, error);
      }
    }
  } catch (e) {
    console.warn('[migrate] legacy data migration failed', e);
  }
  return moved;
}

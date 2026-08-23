/** Family + invite registry: data/families/<id>.json, data/invites/<id>.json.
 *  A family is owned by exactly one family-type account. Invites carry the family
 *  key sealed to the invitee's public key, so acceptance needs neither party
 *  online at the same time. A pending invite is simply an existing record. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope, isSealedBox, type Envelope, type SealedBox } from './crypto.ts';

export interface Family {
  id: string;
  /** Empty when the caller supplied no family key — the deployer's view of a family. */
  name: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

/** On-disk record: the name is sealed under the family key (`name` = legacy plaintext row). */
interface StoredFamily {
  id: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  encName: Envelope | null;
  legacyName: string | null;
}

export interface Invite {
  id: string;
  familyId: string;
  inviterId: string;
  inviteeId: string;
  sealedFk: SealedBox;
  createdAt: number;
}

const FAMILY_DIR = fileURLToPath(new URL('../data/families/', import.meta.url));
const INVITE_DIR = fileURLToPath(new URL('../data/invites/', import.meta.url));
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_NAME = 40;

let families: Map<string, StoredFamily> | null = null;
let invites: Map<string, Invite> | null = null;
let familiesLoad: Promise<Map<string, StoredFamily>> | null = null;
let invitesLoad: Promise<Map<string, Invite>> | null = null;
const familyQueue = createKeyedQueue();
const inviteQueue = createKeyedQueue();

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
}

function normalizeFamily(raw: unknown): StoredFamily | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
  if (typeof v.ownerId !== 'string' || !ID_RE.test(v.ownerId)) return null;
  const legacyName = cleanName(v.name);
  if (!isEnvelope(v.encName) && !legacyName) return null;
  return {
    id: v.id,
    ownerId: v.ownerId,
    createdAt: Number.isFinite(Number(v.createdAt)) ? Number(v.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : Date.now(),
    encName: isEnvelope(v.encName) ? v.encName : null,
    legacyName: isEnvelope(v.encName) ? null : legacyName,
  };
}

function diskJson(stored: StoredFamily): string {
  const { legacyName, encName, ...rest } = stored;
  return JSON.stringify(legacyName ? { ...rest, name: legacyName } : { ...rest, encName });
}

function tryOpenName(env: Envelope, fk: Buffer): string {
  try {
    return decryptJson<{ name: string }>(env, fk).name;
  } catch {
    return '';
  }
}

/** The name only comes back when the caller holds the family key. */
function toFamily(stored: StoredFamily, fk?: Buffer): Family {
  const { encName, legacyName, ...rest } = stored;
  let name = legacyName ?? '';
  if (encName) {
    // A wrong key is a display problem, not a request failure: the name is the only thing
    // sealed here, and every other field the caller needs is structural.
    name = fk ? cleanName(tryOpenName(encName, fk)) : '';
  }
  return { ...rest, name };
}

function normalizeInvite(raw: unknown): Invite | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
  if (typeof v.familyId !== 'string' || !ID_RE.test(v.familyId)) return null;
  if (typeof v.inviterId !== 'string' || !ID_RE.test(v.inviterId)) return null;
  if (typeof v.inviteeId !== 'string' || !ID_RE.test(v.inviteeId)) return null;
  if (!isSealedBox(v.sealedFk)) return null;
  return {
    id: v.id,
    familyId: v.familyId,
    inviterId: v.inviterId,
    inviteeId: v.inviteeId,
    sealedFk: v.sealedFk,
    createdAt: Number.isFinite(Number(v.createdAt)) ? Number(v.createdAt) : Date.now(),
  };
}

async function loadDir<T>(
  dir: string,
  normalize: (raw: unknown) => T | null,
  getId: (item: T) => string,
): Promise<Map<string, T>> {
  await mkdir(dir, { recursive: true });
  const map = new Map<string, T>();
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const item = normalize(JSON.parse(await readFile(dir + f, 'utf8')));
      if (!item || getId(item) !== f.slice(0, -'.json'.length)) continue;
      map.set(getId(item), item);
    } catch {
      console.warn('[families] skipping corrupt record', f);
    }
  }
  return map;
}

async function loadFamilies(): Promise<Map<string, StoredFamily>> {
  if (families) return families;
  familiesLoad ??= loadDir(FAMILY_DIR, normalizeFamily, (f) => f.id).then((m) => (families = m));
  try {
    return await familiesLoad;
  } catch (e) {
    familiesLoad = null;
    throw e;
  }
}

async function loadInvites(): Promise<Map<string, Invite>> {
  if (invites) return invites;
  invitesLoad ??= loadDir(INVITE_DIR, normalizeInvite, (i) => i.id).then((m) => (invites = m));
  try {
    return await invitesLoad;
  } catch (e) {
    invitesLoad = null;
    throw e;
  }
}

export async function createFamily(name: string, ownerId: string, fk: Buffer, id?: string): Promise<Family> {
  const now = Date.now();
  const clean = cleanName(name) || '我的家庭';
  const stored = normalizeFamily({
    id: id && ID_RE.test(id) ? id : randomUUID(),
    ownerId,
    createdAt: now,
    updatedAt: now,
    encName: encryptJson({ name: clean }, fk),
  });
  if (!stored) throw new Error('invalid family');
  return familyQueue(stored.id, async () => {
    const map = await loadFamilies();
    await mkdir(FAMILY_DIR, { recursive: true });
    await writeAtomic(FAMILY_DIR + stored.id + '.json', diskJson(stored));
    map.set(stored.id, stored);
    return toFamily(stored, fk);
  });
}

/**
 * The pre-v1 migration runs before any account has crypto, so the family it creates for the
 * existing accounts starts as a legacy plaintext row; the first keyed read seals it.
 */
export async function createFamilyUnsealed(name: string, ownerId: string, id?: string): Promise<Family> {
  const now = Date.now();
  const stored = normalizeFamily({
    id: id && ID_RE.test(id) ? id : randomUUID(),
    ownerId,
    createdAt: now,
    updatedAt: now,
    name: cleanName(name) || '我的家庭',
  });
  if (!stored) throw new Error('invalid family');
  return familyQueue(stored.id, async () => {
    const map = await loadFamilies();
    await mkdir(FAMILY_DIR, { recursive: true });
    await writeAtomic(FAMILY_DIR + stored.id + '.json', diskJson(stored));
    map.set(stored.id, stored);
    return toFamily(stored);
  });
}

/**
 * Without [fk] the name comes back empty: the family name is the one thing in this record
 * worth reading, and whoever holds the disk is not supposed to. A row still carrying a
 * plaintext name is re-sealed the first time someone reads it with the key.
 */
export async function getFamily(id: string, fk?: Buffer): Promise<Family | undefined> {
  const stored = (await loadFamilies()).get(id);
  if (!stored) return undefined;
  if (stored.legacyName && fk) void sealLegacyName(stored, fk);
  return toFamily(stored, fk);
}

async function sealLegacyName(stored: StoredFamily, fk: Buffer): Promise<void> {
  await familyQueue(stored.id, async () => {
    const map = await loadFamilies();
    const cur = map.get(stored.id);
    if (!cur?.legacyName) return;
    const next: StoredFamily = { ...cur, encName: encryptJson({ name: cur.legacyName }, fk), legacyName: null };
    await writeAtomic(FAMILY_DIR + cur.id + '.json', diskJson(next));
    map.set(cur.id, next);
  }).catch((e: unknown) => console.warn('[families] cannot seal legacy name', e));
}

/** Ops listing: structure only, never the names. */
export async function listFamilies(): Promise<Family[]> {
  return [...(await loadFamilies()).values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((f) => toFamily(f));
}

/** Ops dissolution: remove the family record (member/scope cleanup is the caller's). */
export async function deleteFamily(id: string): Promise<boolean> {
  return familyQueue(id, async () => {
    const map = await loadFamilies();
    if (!map.has(id)) return false;
    await rm(FAMILY_DIR + id + '.json', { force: true });
    map.delete(id);
    return true;
  });
}

export async function countFamilies(): Promise<number> {
  return (await loadFamilies()).size;
}

export async function createInvite(input: Omit<Invite, 'id' | 'createdAt'>): Promise<Invite> {
  const invite = normalizeInvite({ ...input, id: randomUUID(), createdAt: Date.now() });
  if (!invite) throw new Error('invalid invite');
  return inviteQueue(invite.id, async () => {
    const map = await loadInvites();
    await mkdir(INVITE_DIR, { recursive: true });
    await writeAtomic(INVITE_DIR + invite.id + '.json', JSON.stringify(invite));
    map.set(invite.id, invite);
    return invite;
  });
}

export async function getInvite(id: string): Promise<Invite | undefined> {
  return ID_RE.test(id) ? (await loadInvites()).get(id) : undefined;
}

export async function deleteInvite(id: string): Promise<boolean> {
  return inviteQueue(id, async () => {
    const map = await loadInvites();
    if (!map.has(id)) return false;
    await rm(INVITE_DIR + id + '.json', { force: true });
    map.delete(id);
    return true;
  });
}

export async function listInvitesForFamily(familyId: string): Promise<Invite[]> {
  return [...(await loadInvites()).values()]
    .filter((i) => i.familyId === familyId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function listInvitesForAccount(inviteeId: string): Promise<Invite[]> {
  return [...(await loadInvites()).values()]
    .filter((i) => i.inviteeId === inviteeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Family + invite registry: data/families/<id>.json, data/invites/<id>.json.
 *  A family is owned by exactly one family-type account. Invites carry the family
 *  key sealed to the invitee's public key, so acceptance needs neither party
 *  online at the same time. A pending invite is simply an existing record. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { isSealedBox, type SealedBox } from './crypto.ts';

export interface Family {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
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

let families: Map<string, Family> | null = null;
let invites: Map<string, Invite> | null = null;
let familiesLoad: Promise<Map<string, Family>> | null = null;
let invitesLoad: Promise<Map<string, Invite>> | null = null;
const familyQueue = createKeyedQueue();
const inviteQueue = createKeyedQueue();

function normalizeFamily(raw: unknown): Family | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
  if (typeof v.ownerId !== 'string' || !ID_RE.test(v.ownerId)) return null;
  if (typeof v.name !== 'string' || !v.name.trim()) return null;
  return {
    id: v.id,
    name: v.name.trim().slice(0, MAX_NAME),
    ownerId: v.ownerId,
    createdAt: Number.isFinite(Number(v.createdAt)) ? Number(v.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : Date.now(),
  };
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

async function loadFamilies(): Promise<Map<string, Family>> {
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

export async function createFamily(name: string, ownerId: string, id?: string): Promise<Family> {
  const now = Date.now();
  const family = normalizeFamily({
    id: id && ID_RE.test(id) ? id : randomUUID(),
    name: name.trim() || '我的家庭',
    ownerId,
    createdAt: now,
    updatedAt: now,
  });
  if (!family) throw new Error('invalid family');
  return familyQueue(family.id, async () => {
    const map = await loadFamilies();
    await mkdir(FAMILY_DIR, { recursive: true });
    await writeAtomic(FAMILY_DIR + family.id + '.json', JSON.stringify(family));
    map.set(family.id, family);
    return family;
  });
}

export async function getFamily(id: string): Promise<Family | undefined> {
  return (await loadFamilies()).get(id);
}

export async function listFamilies(): Promise<Family[]> {
  return [...(await loadFamilies()).values()].sort((a, b) => a.createdAt - b.createdAt);
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

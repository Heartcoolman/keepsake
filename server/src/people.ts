/** File-backed people registry: data/people/<id>.json.
 *  Scoped per family (or per standalone account): `scopeId` is plaintext for
 *  indexing, while {name, relations, templates} — face templates are biometric —
 *  live in an AES-GCM envelope under the scope key (family FK or owner UDK).
 *  Every read decrypts into a transient Person; the module map only ever holds
 *  ciphertext. Legacy plaintext rows read as-is until lazily rewritten. */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope, type Envelope } from './crypto.ts';

export interface Person {
  id: string;
  scopeId: string;
  name: string;
  /** @deprecated legacy household-wide label — migrated into relations */
  relation: string;
  /** per-account perspective: accountId → this person's relation to that account */
  relations: Record<string, string>;
  isUser: boolean;
  createdAt: number;
  updatedAt: number;
  templates: number[][];
  enrolledFrom: { entryId: string; faceIndex: number }[];
}

export interface PersonDTO {
  id: string;
  name: string;
  relation: string;
  isUser: boolean;
  createdAt: number;
  updatedAt: number;
  templateCount: number;
  enrolledFrom: { entryId: string; faceIndex: number }[];
}

/** relation on the wire is always the viewer's own perspective */
export function relationFor(p: Person, viewerId: string): string {
  if (p.id === viewerId) return '本人';
  return p.relations[viewerId] ?? '';
}

export function toDTO(p: Person, viewerId: string): PersonDTO {
  return {
    id: p.id,
    name: p.name,
    relation: relationFor(p, viewerId),
    isUser: p.isUser,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    templateCount: p.templates.length,
    enrolledFrom: p.enrolledFrom,
  };
}

const DIR = fileURLToPath(new URL('../data/people/', import.meta.url));
const MAX_TEMPLATES = 100;
const MAX_EMBEDDING = 512;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

interface PersonContent {
  name: string;
  relation: string;
  relations: Record<string, string>;
  templates: number[][];
}

/** On-disk record: sensitive bundle in `enc` (null = legacy plaintext row). */
interface StoredPerson {
  id: string;
  scopeId: string;
  isUser: boolean;
  createdAt: number;
  updatedAt: number;
  enrolledFrom: { entryId: string; faceIndex: number }[];
  enc: Envelope | null;
  /** inline content, only for legacy rows */
  legacy: PersonContent | null;
}

let index: Map<string, StoredPerson> | null = null;
let indexLoad: Promise<Map<string, StoredPerson>> | null = null;
const enqueue = createKeyedQueue();

function normalizeContent(value: Record<string, unknown>): PersonContent | null {
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  const templates = Array.isArray(value.templates)
    ? value.templates
        .filter((row): row is number[] => Array.isArray(row) && row.length > 0 && row.length <= MAX_EMBEDDING)
        .map((row) => row.map(Number).filter(Number.isFinite).slice(0, MAX_EMBEDDING))
        .filter((row) => row.length > 0)
        .slice(-MAX_TEMPLATES)
    : [];
  const relations: Record<string, string> = {};
  if (value.relations && typeof value.relations === 'object') {
    for (const [k, v] of Object.entries(value.relations as Record<string, unknown>).slice(0, 32)) {
      if (!ID_RE.test(k) || typeof v !== 'string' || !v.trim()) continue;
      relations[k] = v.trim().slice(0, 40);
    }
  }
  return {
    name: value.name.trim().slice(0, 40),
    relation: typeof value.relation === 'string' ? value.relation.trim().slice(0, 40) : '',
    relations,
    templates,
  };
}

function normalizeStructural(value: Record<string, unknown>): Omit<StoredPerson, 'enc' | 'legacy'> | null {
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return null;
  const enrolledFrom = Array.isArray(value.enrolledFrom)
    ? value.enrolledFrom
        .filter((row): row is { entryId: string; faceIndex: number } =>
          !!row && typeof row === 'object' &&
          typeof (row as Record<string, unknown>).entryId === 'string' &&
          Number.isInteger(Number((row as Record<string, unknown>).faceIndex)),
        )
        .map((row) => ({ entryId: row.entryId.slice(0, 64), faceIndex: Math.max(0, Math.min(19, Number(row.faceIndex))) }))
        .slice(-MAX_TEMPLATES)
    : [];
  return {
    id: value.id,
    scopeId: typeof value.scopeId === 'string' && ID_RE.test(value.scopeId) ? value.scopeId : '',
    isUser: value.isUser === true,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
    enrolledFrom,
  };
}

function parseStored(raw: unknown): StoredPerson | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const structural = normalizeStructural(value);
  if (!structural) return null;
  if (isEnvelope(value.enc)) return { ...structural, enc: value.enc, legacy: null };
  const legacy = normalizeContent(value);
  if (!legacy) return null;
  return { ...structural, enc: null, legacy };
}

function decryptStored(stored: StoredPerson, key: Buffer | undefined): Person {
  let content: PersonContent;
  if (stored.legacy) {
    content = stored.legacy;
  } else {
    if (!key) throw Object.assign(new Error('person content locked'), { status: 423 });
    const raw = decryptJson<Record<string, unknown>>(stored.enc!, key);
    const normalized = normalizeContent(raw);
    if (!normalized) throw new Error('corrupt person content');
    content = normalized;
  }
  return {
    id: stored.id,
    scopeId: stored.scopeId,
    isUser: stored.isUser,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    enrolledFrom: stored.enrolledFrom,
    ...content,
  };
}

function toStored(p: Person, key: Buffer): StoredPerson {
  const content: PersonContent = {
    name: p.name,
    relation: p.relation,
    relations: p.relations,
    templates: p.templates,
  };
  return {
    id: p.id,
    scopeId: p.scopeId,
    isUser: p.isUser,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    enrolledFrom: p.enrolledFrom,
    enc: encryptJson(content, key),
    legacy: null,
  };
}

function diskJson(stored: StoredPerson): string {
  const { legacy, ...rest } = stored;
  if (legacy) {
    const { enc: _enc, ...structural } = rest;
    return JSON.stringify({ ...structural, ...legacy });
  }
  return JSON.stringify(rest);
}

/** Validate a Person shape before persisting (mirrors the legacy normalizePerson). */
function normalizePerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const structural = normalizeStructural(value);
  const content = normalizeContent(value);
  if (!structural || !content) return null;
  return { ...structural, ...content };
}

async function writeStoredAtomic(stored: StoredPerson): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeAtomic(DIR + stored.id + '.json', diskJson(stored));
}

async function load(): Promise<Map<string, StoredPerson>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, StoredPerson>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const p = parseStored(JSON.parse(await readFile(DIR + f, 'utf8')));
          if (!p) throw new Error('invalid person');
          map.set(p.id, p);
        } catch {
          console.warn('[people] skipping corrupt person', f);
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

/** Everyone in one scope, decrypted with that scope's key. */
export async function listPeople(scopeId: string, key: Buffer | undefined): Promise<Person[]> {
  return [...(await load()).values()]
    .filter((p) => p.scopeId === scopeId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => decryptStored(p, key));
}

/** ids of rows in a scope still stored as legacy plaintext */
export async function listLegacyPersonIds(scopeId?: string): Promise<string[]> {
  return [...(await load()).values()]
    .filter((p) => !!p.legacy && (!scopeId || p.scopeId === scopeId))
    .map((p) => p.id);
}

/** Structural existence/scope check without any key. */
export async function getPersonScope(
  id: string,
): Promise<{ id: string; scopeId: string; isUser: boolean } | undefined> {
  const p = (await load()).get(id);
  return p ? { id: p.id, scopeId: p.scopeId, isUser: p.isUser } : undefined;
}

export async function getPerson(id: string, key: Buffer | undefined): Promise<Person | undefined> {
  const p = (await load()).get(id);
  return p ? decryptStored(p, key) : undefined;
}

export async function putPerson(p: Person, key: Buffer): Promise<void> {
  const safe = normalizePerson(p);
  if (!safe) throw new Error('invalid person');
  await enqueue(safe.id, async () => {
    const map = await load();
    const stored = toStored(safe, key);
    await writeStoredAtomic(stored);
    map.set(safe.id, stored);
  });
}

/** Read, modify, and persist one person while holding the same record lock. */
export async function updatePerson(
  id: string,
  key: Buffer,
  update: (current: Person) => Person,
): Promise<Person | undefined> {
  return enqueue(id, async () => {
    const map = await load();
    const current = map.get(id);
    if (!current) return undefined;
    const next = normalizePerson(update(decryptStored(current, key)));
    if (!next || next.id !== id) throw new Error('invalid person update');
    const stored = toStored(next, key);
    await writeStoredAtomic(stored);
    map.set(id, stored);
    return next;
  });
}

/** Lazy at-rest migration of one legacy row into the encrypted shape. */
export async function encryptPersonRecord(id: string, key: Buffer): Promise<boolean> {
  return enqueue(id, async () => {
    const map = await load();
    const current = map.get(id);
    if (!current?.legacy) return false;
    const stored = toStored(decryptStored(current, undefined), key);
    await writeStoredAtomic(stored);
    map.set(id, stored);
    return true;
  });
}

/** Re-encrypt every record in a scope under a new key (family-key rotation). */
export async function reencryptScope(scopeId: string, oldKey: Buffer, newKey: Buffer): Promise<void> {
  for (const id of [...(await load()).values()].filter((p) => p.scopeId === scopeId).map((p) => p.id)) {
    await enqueue(id, async () => {
      const map = await load();
      const current = map.get(id);
      if (!current || current.scopeId !== scopeId) return;
      const person = decryptStored(current, oldKey);
      const stored = toStored(person, newKey);
      await writeStoredAtomic(stored);
      map.set(id, stored);
    });
  }
}

/** Move one person between scopes, re-encrypting under the destination key. */
export async function movePersonToScope(
  id: string,
  fromKey: Buffer | undefined,
  toScopeId: string,
  toKey: Buffer,
): Promise<Person | undefined> {
  return enqueue(id, async () => {
    const map = await load();
    const current = map.get(id);
    if (!current) return undefined;
    const person = { ...decryptStored(current, fromKey), scopeId: toScopeId, updatedAt: Date.now() };
    const stored = toStored(person, toKey);
    await writeStoredAtomic(stored);
    map.set(id, stored);
    return person;
  });
}

/** Create or update a display name as one operation, preventing duplicate people
 * when two browsers submit the same new person at the same time. Scope-local. */
export async function upsertPersonByName(
  candidate: Person,
  key: Buffer,
  updateExisting: (current: Person) => Person,
): Promise<{ person: Person; created: boolean }> {
  const name = candidate.name.trim();
  return enqueue(`@name:${candidate.scopeId}:${name}`, async () => {
    const existing = (await listPeople(candidate.scopeId, key)).find((p) => p.name === name);
    if (existing) {
      const person = await updatePerson(existing.id, key, updateExisting);
      if (!person) throw new Error('person disappeared during update');
      return { person, created: false };
    }
    const safe = normalizePerson(candidate);
    if (!safe) throw new Error('invalid person');
    await enqueue(safe.id, async () => {
      const map = await load();
      if (map.has(safe.id)) throw new Error('person id already exists');
      const stored = toStored(safe, key);
      await writeStoredAtomic(stored);
      map.set(safe.id, stored);
    });
    return { person: safe, created: true };
  });
}

/** Merge two records under stable lock ordering so opposite concurrent merges cannot deadlock. */
export async function mergePeople(
  targetId: string,
  fromId: string,
  key: Buffer,
): Promise<Person | undefined> {
  if (targetId === fromId) return undefined;
  const [first, second] = [targetId, fromId].sort();
  return enqueue(first!, () => enqueue(second!, async () => {
    const map = await load();
    const targetStored = map.get(targetId);
    const fromStored = map.get(fromId);
    if (!targetStored || !fromStored) return undefined;
    const target = decryptStored(targetStored, key);
    const from = decryptStored(fromStored, key);
    const next = normalizePerson({
      ...target,
      isUser: target.isUser || from.isUser,
      relations: { ...from.relations, ...target.relations },
      templates: [...target.templates, ...from.templates].slice(-MAX_TEMPLATES),
      enrolledFrom: [...target.enrolledFrom, ...from.enrolledFrom].slice(-MAX_TEMPLATES),
      updatedAt: Date.now(),
    });
    if (!next) throw new Error('invalid merged person');
    const stored = toStored(next, key);
    await writeStoredAtomic(stored);
    await rm(DIR + fromId + '.json', { force: true });
    map.set(targetId, stored);
    map.delete(fromId);
    return next;
  }));
}

export async function deletePerson(id: string): Promise<boolean> {
  return enqueue(id, async () => {
    const map = await load();
    if (!map.has(id)) return false;
    await rm(DIR + id + '.json', { force: true });
    map.delete(id);
    return true;
  });
}

/** Ops purge / family dissolution: remove every person record in a scope.
 *  Structural — no key needed; the ciphertext is being abandoned. */
export async function deleteScopeData(scopeId: string): Promise<number> {
  let removed = 0;
  for (const p of [...(await load()).values()].filter((p) => p.scopeId === scopeId)) {
    if (await deletePerson(p.id)) removed++;
  }
  return removed;
}

/** Assign a scope to a legacy row without touching its (still plaintext) content. */
export async function assignScope(id: string, scopeId: string): Promise<void> {
  await enqueue(id, async () => {
    const map = await load();
    const current = map.get(id);
    if (!current || current.scopeId === scopeId) return;
    const next: StoredPerson = { ...current, scopeId };
    await writeStoredAtomic(next);
    map.set(id, next);
  });
}

/** Every record's structural view — for migrations that must not need keys. */
export async function listScopes(): Promise<{ id: string; scopeId: string; isUser: boolean }[]> {
  return [...(await load()).values()].map((p) => ({ id: p.id, scopeId: p.scopeId, isUser: p.isUser }));
}

/** One-shot migration: the legacy household-wide relation label becomes the
 *  primary owner's per-account view. isUser persons keep their legacy '本人'. */
export async function migrateLegacyRelations(
  scopeId: string,
  key: Buffer,
  primaryId: string,
): Promise<void> {
  let moved = 0;
  for (const p of await listPeople(scopeId, key)) {
    if (p.isUser || !p.relation.trim()) continue;
    await updatePerson(p.id, key, (cur) => ({
      ...cur,
      relations: { [primaryId]: cur.relation.trim(), ...cur.relations },
      relation: '',
    }));
    moved++;
  }
  if (moved) console.log(`[people] migrated ${moved} legacy relation label(s) to account ${primaryId}`);
}

/** exact name match within a scope; first hit (stable by createdAt) */
export async function findByName(
  scopeId: string,
  key: Buffer,
  name: string,
): Promise<Person | undefined> {
  const n = name.trim();
  if (!n) return undefined;
  return (await listPeople(scopeId, key)).find((p) => p.name === n);
}

export interface ConsolidationResult {
  absorbed: number;
  /** Every merge performed, so the caller can rewrite entry person refs. */
  merges: { keeperId: string; absorbedIds: string[] }[];
}

/**
 * Same display name must be one Person — otherwise face templates land on a non-user
 * clone while the isUser account stays faceless, and diary/chat third-person the clone
 * as if they were someone else. Keeper: protected (account-linked) > isUser > more
 * templates > older. A person whose id is in `protectedIds` is a login identity and is
 * never deleted; groups containing two or more protected persons are skipped entirely
 * (merging them would destroy one account's face profile). Scope-local.
 */
export async function consolidateDuplicateNames(
  scopeId: string,
  key: Buffer,
  protectedIds: ReadonlySet<string> = new Set(),
): Promise<ConsolidationResult> {
  const groups = new Map<string, Person[]>();
  for (const p of await listPeople(scopeId, key)) {
    const k = p.name.trim();
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(p);
    groups.set(k, g);
  }
  const result: ConsolidationResult = { absorbed: 0, merges: [] };
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    if (group.filter((p) => protectedIds.has(p.id)).length > 1) {
      console.warn(
        `[people] skip consolidating "${name}": multiple account-linked persons share this name`,
      );
      continue;
    }
    group.sort((a, b) => {
      const ap = protectedIds.has(a.id);
      const bp = protectedIds.has(b.id);
      if (ap !== bp) return ap ? -1 : 1;
      if (a.isUser !== b.isUser) return a.isUser ? -1 : 1;
      if (b.templates.length !== a.templates.length) return b.templates.length - a.templates.length;
      return a.createdAt - b.createdAt;
    });
    const keeper = group[0]!;
    const merge = { keeperId: keeper.id, absorbedIds: [] as string[] };
    for (const other of group.slice(1)) {
      // Delegate to mergePeople so each absorb is an atomic, in-lock
      // read-modify-write-delete instead of a stale putPerson+deletePerson pair.
      const merged = await mergePeople(keeper.id, other.id, key);
      if (!merged) continue;
      merge.absorbedIds.push(other.id);
      result.absorbed++;
    }
    if (merge.absorbedIds.length) result.merges.push(merge);
  }
  return result;
}

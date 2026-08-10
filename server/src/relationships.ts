/** File-backed person↔person relationship edges.
 *  One record per unordered pair; cooccurrence (photo co-appearance) and AI-inferred
 *  evidence share the record. label === '' means cooccurrence-only.
 *
 *  At rest, an edge reveals nothing but its scope: {a, b, label, confidence, evidence}
 *  all live in a scope-key envelope, and the file is named by a keyed tag
 *  (`data/relationships/<tag>.json`) rather than by the pair. The pair id was
 *  previously the filename, which handed the entire relationship graph — who is
 *  connected to whom — to anyone who could list the directory, even though the
 *  labels themselves were encrypted. `scopeId` and the timestamps stay plaintext:
 *  scope deletion, ops purge and the boot migration must work without any key.
 *
 *  The wire shape is unchanged: `Relationship.id` is still `<a>__<b>`, recomputed
 *  in memory after decryption, so clients (and the virtual-edge overlay in
 *  relationshipRoutes) see exactly what they saw before. Legacy plaintext rows keep
 *  their old pair filename until the lazy migration rewrites them under a tag. */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope, keyedTag, type Envelope } from './crypto.ts';
import { relationExtractionPrompt } from './prompts.ts';
import { xaiChat } from './xai.ts';
import * as people from './people.ts';
import * as store from './store.ts';

export interface RelationEvidence {
  entryId: string;
  kind: 'cooccur' | 'ai';
  createdAt: number;
}

export interface Relationship {
  id: string;
  a: string;
  b: string;
  scopeId: string;
  label: string;
  confidence: number;
  evidence: RelationEvidence[];
  createdAt: number;
  updatedAt: number;
}

const DIR = fileURLToPath(new URL('../data/relationships/', import.meta.url));
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_EVIDENCE = 20;
const MAX_LABEL = 40;
/** Fill an empty Person.relation vs overwrite a non-empty (possibly hand-typed) one. */
const WRITE_BACK_MIN = 0.6;
const WRITE_BACK_OVERWRITE = 0.85;
const MOCK = process.env.MOCK_AI === '1';

/** The sensitive half of an edge — everything that describes the connection. */
interface RelationContent {
  a: string;
  b: string;
  label: string;
  confidence: number;
  evidence: RelationEvidence[];
}

/** On-disk record. `storageId` is the filename stem: a keyed tag for records in the
 *  current shape, the plaintext pair id for anything not migrated yet — which is
 *  also how migration status is detected, since a tag can never contain '__'. */
interface StoredRelationship {
  storageId: string;
  scopeId: string;
  createdAt: number;
  updatedAt: number;
  enc: Envelope | null;
  legacy: RelationContent | null;
  /** The shape that shipped before the endpoints moved inside: `{label, evidence}`
   *  in the envelope, with `a`/`b`/`confidence` beside it in the clear. Those outer
   *  fields are the only copy of the endpoints such a row has, so they are kept to
   *  complete the decrypted content until the row is rewritten. */
  outerEndpoints: { a: string; b: string; confidence: number } | null;
}

let index: Map<string, StoredRelationship> | null = null;
let indexLoad: Promise<Map<string, StoredRelationship>> | null = null;
const enqueue = createKeyedQueue();

const pairId = (x: string, y: string): string => {
  const [a, b] = [x, y].sort();
  return `${a}__${b}`;
};

/** Filename for an encrypted edge. Key-bound: rotating the scope key renames the
 *  record, which is why reencryptScope has to move the file rather than rewrite it. */
const pairTag = (key: Buffer, pair: string): string => keyedTag(key, 'relationship', pair);

/** Lock both slots a record can occupy (its current name and its destination tag)
 *  in a stable order, so a rewrite that relocates a row cannot race a concurrent
 *  encrypt/delete on either name. Same nested-lock idiom as people.mergePeople.
 *  When the two coincide — a rotation replay where the row already sits at its
 *  destination — the lock is taken once: re-entering the same key would deadlock
 *  against the outer hold, which is the queue's whole point. */
function enqueuePair<T>(a: string, b: string, task: () => Promise<T>): Promise<T> {
  return enqueueAll([a, b], task);
}

/** Lock every storage location a task will read or write, deduplicated and in a
 *  stable order. Whatever the task might reach must be in here: a name that is read
 *  but not held can be deleted between the read and the write, which silently
 *  resurrects the deleted record. */
function enqueueAll<T>(keys: string[], task: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  return ordered.reduceRight<() => Promise<T>>(
    (next, key) => () => enqueue(key, next),
    task,
  )();
}

function numOr(v: unknown, fallback: number): number {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function normalizeEvidence(raw: unknown): RelationEvidence[] {
  return Array.isArray(raw)
    ? raw
        .flatMap((item): RelationEvidence[] => {
          if (!item || typeof item !== 'object') return [];
          const e = item as Record<string, unknown>;
          if (typeof e.entryId !== 'string' || !e.entryId) return [];
          if (e.kind !== 'cooccur' && e.kind !== 'ai') return [];
          return [{
            entryId: e.entryId.slice(0, 64),
            kind: e.kind,
            createdAt: Number.isFinite(Number(e.createdAt)) ? Number(e.createdAt) : Date.now(),
          }];
        })
        .slice(-MAX_EVIDENCE)
    : [];
}

/** Validate the sensitive half. Returns null when the endpoints are unusable —
 *  which is also what rejects a corrupt or wrong-key decryption. */
function normalizeContent(raw: unknown): RelationContent | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.a !== 'string' || !ID_RE.test(value.a)) return null;
  if (typeof value.b !== 'string' || !ID_RE.test(value.b)) return null;
  if (value.a === value.b) return null;
  const [a, b] = [value.a, value.b].sort() as [string, string];
  const confidence = Number(value.confidence);
  return {
    a,
    b,
    label: typeof value.label === 'string' ? value.label.trim().slice(0, MAX_LABEL) : '',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    evidence: normalizeEvidence(value.evidence),
  };
}

function normalizeRelationship(raw: unknown): Relationship | null {
  const content = normalizeContent(raw);
  if (!content) return null;
  const value = raw as Record<string, unknown>;
  const now = Date.now();
  return {
    id: pairId(content.a, content.b),
    ...content,
    scopeId: typeof value.scopeId === 'string' && ID_RE.test(value.scopeId) ? value.scopeId : '',
    createdAt: numOr(value.createdAt, now),
    updatedAt: numOr(value.updatedAt, now),
  };
}

function parseStored(storageId: string, raw: unknown): StoredRelationship | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const now = Date.now();
  const scopeId =
    typeof value.scopeId === 'string' && ID_RE.test(value.scopeId) ? value.scopeId : '';
  const base = {
    storageId,
    scopeId,
    createdAt: numOr(value.createdAt, now),
    updatedAt: numOr(value.updatedAt, now),
  };
  if (isEnvelope(value.enc)) {
    const outer = normalizeContent(value);
    return {
      ...base,
      enc: value.enc,
      legacy: null,
      outerEndpoints: outer ? { a: outer.a, b: outer.b, confidence: outer.confidence } : null,
    };
  }
  const legacy = normalizeContent(value);
  if (!legacy) return null;
  return { ...base, enc: null, legacy, outerEndpoints: null };
}

function decryptStored(stored: StoredRelationship, key: Buffer | undefined): Relationship {
  let content: RelationContent;
  if (stored.legacy) {
    content = stored.legacy;
  } else {
    if (!key) throw Object.assign(new Error('relationship content locked'), { status: 423 });
    const raw = decryptJson<Record<string, unknown>>(stored.enc!, key);
    // Pre-migration envelopes hold only {label, evidence}; their endpoints are the
    // outer plaintext fields, so completing the record needs both halves.
    const normalized =
      normalizeContent(raw) ??
      (stored.outerEndpoints ? normalizeContent({ ...raw, ...stored.outerEndpoints }) : null);
    if (!normalized) throw new Error('corrupt relationship content');
    content = normalized;
  }
  return {
    id: pairId(content.a, content.b),
    ...content,
    scopeId: stored.scopeId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function toStored(storageId: string, r: Relationship, key: Buffer): StoredRelationship {
  return {
    storageId,
    scopeId: r.scopeId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    enc: encryptJson(
      { a: r.a, b: r.b, label: r.label, confidence: r.confidence, evidence: r.evidence },
      key,
    ),
    legacy: null,
    outerEndpoints: null,
  };
}

/** A record still carrying its endpoints in the filename — plaintext row or the
 *  earlier envelope shape. Tags are hex, so '__' marks exactly the un-migrated ones. */
const needsMigration = (stored: StoredRelationship): boolean => stored.storageId.includes('__');

function diskJson(stored: StoredRelationship): string {
  const base = {
    scopeId: stored.scopeId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  // Un-migrated rows keep their original inline shape until the lazy migration
  // runs: for the earlier envelope shape that means preserving the outer endpoints,
  // which are its ONLY copy — writing the new shape over them would leave an
  // envelope whose {label, evidence} can never be tied back to a pair again.
  if (stored.legacy) return JSON.stringify({ id: stored.storageId, ...stored.legacy, ...base });
  return JSON.stringify({ ...base, ...(stored.outerEndpoints ?? {}), enc: stored.enc });
}

async function writeStoredAtomic(stored: StoredRelationship): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeAtomic(DIR + stored.storageId + '.json', diskJson(stored));
}

/** Replace a record's file when its storage id changed (legacy→tag, or a rotation
 *  that re-derives the tag). Writes the new file first so a crash cannot lose the
 *  edge — at worst it leaves a stale copy the next pass overwrites. */
async function relocate(
  map: Map<string, StoredRelationship>,
  fromId: string,
  stored: StoredRelationship,
): Promise<void> {
  await writeStoredAtomic(stored);
  map.set(stored.storageId, stored);
  if (fromId === stored.storageId) return;
  await rm(DIR + fromId + '.json', { force: true });
  map.delete(fromId);
}

async function load(): Promise<Map<string, StoredRelationship>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, StoredRelationship>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        const storageId = f.slice(0, -'.json'.length);
        try {
          const r = parseStored(storageId, JSON.parse(await readFile(DIR + f, 'utf8')));
          if (!r) throw new Error('invalid relationship');
          map.set(r.storageId, r);
        } catch {
          console.warn('[relationships] skipping corrupt relationship', f);
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

export async function listRelationships(scopeId: string, key: Buffer | undefined): Promise<Relationship[]> {
  const out: Relationship[] = [];
  for (const stored of [...(await load()).values()]
    .filter((r) => r.scopeId === scopeId)
    .sort((a, b) => a.createdAt - b.createdAt)) {
    try {
      out.push(decryptStored(stored, key));
    } catch (e) {
      // One unreadable edge must not take the whole graph down with it — the old
      // shape failed closed at load time, per file; keep that blast radius.
      console.warn('[relationships] skipping unreadable edge', stored.storageId, e);
    }
  }
  return out;
}

/** Ids of records not yet in the current at-rest shape — plaintext rows AND rows
 *  whose envelope predates the endpoints moving inside. Both are still named by
 *  their pair, which is the leak the migration exists to close. */
export async function listLegacyRelationshipIds(scopeId?: string): Promise<string[]> {
  return [...(await load()).values()]
    .filter((r) => needsMigration(r) && (!scopeId || r.scopeId === scopeId))
    .map((r) => r.storageId);
}

/** Structural scope check by storage id, without a key (boot migration). */
export async function getRelationshipScope(storageId: string): Promise<string | undefined> {
  return (await load()).get(storageId)?.scopeId;
}

/** Internal primitive: delete by storage id (scope-wide purges own the check). */
export async function deleteRelationship(storageId: string): Promise<boolean> {
  return enqueue(storageId, async () => {
    const map = await load();
    if (!map.has(storageId)) return false;
    await rm(DIR + storageId + '.json', { force: true });
    map.delete(storageId);
    return true;
  });
}

/** Delete by the wire id (`<a>__<b>`) a client holds. The pair only names a file
 *  through the scope key, so resolving it is itself the proof of scope membership;
 *  the explicit scopeId check stays as the authorization gate. */
export async function deleteRelationshipInScope(
  wireId: string,
  scopeId: string,
  key: Buffer,
): Promise<boolean> {
  const map = await load();
  const tag = pairTag(key, wireId);
  const stored = map.get(tag) ?? map.get(wireId);
  if (!stored || stored.scopeId !== scopeId) return false;
  return deleteRelationship(stored.storageId);
}

/** Ops purge / family dissolution: remove every edge in a scope (no key needed). */
export async function deleteScopeData(scopeId: string): Promise<number> {
  let removed = 0;
  for (const r of [...(await load()).values()].filter((r) => r.scopeId === scopeId)) {
    if (await deleteRelationship(r.storageId)) removed++;
  }
  return removed;
}

/** Assign a scope to a legacy row without touching its plaintext content. */
export async function assignScope(storageId: string, scopeId: string): Promise<void> {
  await enqueue(storageId, async () => {
    const map = await load();
    const current = map.get(storageId);
    if (!current || current.scopeId === scopeId) return;
    const next: StoredRelationship = { ...current, scopeId };
    await writeStoredAtomic(next);
    map.set(storageId, next);
  });
}

/** Lazy at-rest migration of one un-migrated row — plaintext, or the earlier
 *  envelope shape — into the current one: endpoints sealed inside, file renamed to
 *  its keyed tag. */
export async function encryptRelationshipRecord(storageId: string, key: Buffer): Promise<boolean> {
  const map = await load();
  const peek = map.get(storageId);
  if (!peek || !needsMigration(peek)) return false;
  const tag = pairTag(key, decryptStored(peek, key).id);
  return enqueuePair(tag, storageId, async () => {
    const current = map.get(storageId);
    if (!current || !needsMigration(current)) return false;
    await relocate(map, storageId, toStored(tag, decryptStored(current, key), key));
    return true;
  });
}

/** Re-key every relationship in a scope. Both the envelope and the filename are
 *  key-bound, so each record is rewritten under its new tag and the old file
 *  removed. Resumable: the destination key is tried first, so a pass that died
 *  partway converges when re-run over its mix of converted and unconverted rows. */
export async function reencryptScope(scopeId: string, oldKey: Buffer, newKey: Buffer): Promise<void> {
  for (const storageId of [...(await load()).values()]
    .filter((r) => r.scopeId === scopeId)
    .map((r) => r.storageId)) {
    const map = await load();
    const peek = map.get(storageId);
    if (!peek || peek.scopeId !== scopeId) continue;
    let pair: Relationship;
    try {
      pair = decryptStored(peek, newKey);
    } catch {
      try {
        pair = decryptStored(peek, oldKey);
      } catch {
        console.warn('[relationships] skipping edge that matches neither key', storageId);
        continue;
      }
    }
    const tag = pairTag(newKey, pair.id);
    await enqueuePair(tag, storageId, async () => {
      const current = map.get(storageId);
      if (!current || current.scopeId !== scopeId) return;
      let fresh: Relationship;
      try {
        fresh = decryptStored(current, newKey);
      } catch {
        try {
          fresh = decryptStored(current, oldKey);
        } catch {
          // Neither key opens it. Skipping keeps the rest of the scope rotating —
          // an escaping throw would abort the pass and re-abort it identically on
          // every later attempt, stranding every record ordered after this one.
          console.warn('[relationships] skipping edge that matches neither key', storageId);
          return;
        }
      }
      await relocate(map, storageId, toStored(tag, fresh, newKey));
    });
  }
}

/** Read-modify-write one pair record under its lock; creates the record when absent.
 *  A still-unmigrated legacy row for the same pair is adopted and removed in the
 *  same critical section, so an edge can never end up stored twice. */
async function upsertPair(
  x: string,
  y: string,
  scopeId: string,
  key: Buffer,
  mutate: (cur: Relationship) => Relationship | null,
): Promise<void> {
  const pair = pairId(x, y);
  const tag = pairTag(key, pair);
  await enqueuePair(tag, pair, async () => {
    const map = await load();
    const now = Date.now();
    const [a, b] = [x, y].sort() as [string, string];
    const existing = map.get(tag) ?? map.get(pair);
    const cur: Relationship = existing
      ? decryptStored(existing, key)
      : { id: pair, a, b, scopeId, label: '', confidence: 0, evidence: [], createdAt: now, updatedAt: now };
    const mutated = mutate(cur);
    if (!mutated) return;
    const next = normalizeRelationship({ ...mutated, scopeId });
    if (!next || next.id !== pair) throw new Error('invalid relationship update');
    await relocate(map, existing?.storageId ?? tag, toStored(tag, next, key));
  });
}

const hasEvidence = (r: Relationship, entryId: string, kind: RelationEvidence['kind']): boolean =>
  r.evidence.some((e) => e.entryId === entryId && e.kind === kind);

export async function upsertCooccurrence(
  x: string,
  y: string,
  entryId: string,
  scopeId: string,
  key: Buffer,
): Promise<void> {
  await upsertPair(x, y, scopeId, key, (cur) => {
    if (hasEvidence(cur, entryId, 'cooccur')) return null;
    return {
      ...cur,
      evidence: [...cur.evidence, { entryId, kind: 'cooccur' as const, createdAt: Date.now() }].slice(-MAX_EVIDENCE),
      updatedAt: Date.now(),
    };
  });
}

/** Append AI evidence; the label follows the highest confidence seen so far. */
export async function upsertAiRelation(
  x: string,
  y: string,
  label: string,
  confidence: number,
  entryId: string,
  scopeId: string,
  key: Buffer,
): Promise<void> {
  await upsertPair(x, y, scopeId, key, (cur) => {
    if (hasEvidence(cur, entryId, 'ai')) return null;
    const adopt = confidence > cur.confidence;
    return {
      ...cur,
      label: adopt ? label : cur.label,
      confidence: adopt ? confidence : cur.confidence,
      evidence: [...cur.evidence, { entryId, kind: 'ai' as const, createdAt: Date.now() }].slice(-MAX_EVIDENCE),
      updatedAt: Date.now(),
    };
  });
}

const evidenceKey = (e: RelationEvidence): string => `${e.entryId} ${e.kind}`;

/** Keep edges consistent when a person is merged (targetId set) or deleted.
 *  Endpoints live inside the envelope now, so the scope's records are decrypted to
 *  find the ones that touch `fromId` — hence the explicit scopeId. */
export async function rewriteRelationshipRefs(
  fromId: string,
  targetId: string | undefined,
  scopeId: string,
  key: Buffer,
): Promise<void> {
  const map = await load();
  const touched: { storageId: string; rel: Relationship }[] = [];
  for (const stored of map.values()) {
    if (stored.scopeId !== scopeId) continue;
    let rel: Relationship;
    try {
      rel = decryptStored(stored, key);
    } catch {
      continue; // wrong key or corrupt — leave it for the rotation pass
    }
    if (rel.a === fromId || rel.b === fromId) touched.push({ storageId: stored.storageId, rel });
  }

  for (const { storageId, rel } of touched) {
    if (!targetId) {
      await deleteRelationship(storageId);
      continue;
    }
    const other = rel.a === fromId ? rel.b : rel.a;
    if (other === targetId) {
      // merging both endpoints into one person — a self-pair is meaningless
      await deleteRelationship(storageId);
      continue;
    }
    const newPair = pairId(targetId, other);
    const newTag = pairTag(key, newPair);
    // All three names this touches: the source record, and BOTH places the
    // destination pair can live (its keyed tag, and its un-migrated pair filename,
    // which the merge below reads to fold in existing evidence).
    await enqueueAll([newTag, newPair, storageId], async () => {
      const oldStored = map.get(storageId);
      if (!oldStored) return;
      const old = decryptStored(oldStored, key);
      const existingStored = map.get(newTag) ?? map.get(newPair);
      const existing = existingStored ? decryptStored(existingStored, key) : undefined;
      const seen = new Set((existing?.evidence ?? []).map(evidenceKey));
      const evidence = [
        ...(existing?.evidence ?? []),
        ...old.evidence.filter((e) => !seen.has(evidenceKey(e))),
      ]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_EVIDENCE);
      const fromOld = old.confidence >= (existing?.confidence ?? 0);
      const [a, b] = [targetId, other].sort() as [string, string];
      const next = normalizeRelationship({
        a,
        b,
        scopeId: old.scopeId,
        label: fromOld ? old.label : existing!.label,
        confidence: fromOld ? old.confidence : existing!.confidence,
        evidence,
        createdAt: Math.min(old.createdAt, existing?.createdAt ?? old.createdAt),
        updatedAt: Date.now(),
      });
      if (!next) return;
      await relocate(map, existingStored?.storageId ?? newTag, toStored(newTag, next, key));
      if (storageId !== newTag) {
        await rm(DIR + storageId + '.json', { force: true });
        map.delete(storageId);
      }
    });
  }
}

async function aiJson(system: string, user: string, meterId?: string): Promise<Record<string, unknown> | null> {
  const res = await xaiChat(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.2,
    },
    undefined,
    meterId,
  );
  if (!res.ok) {
    console.warn('[relationships] extraction upstream', res.status);
    return null;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (data.choices?.[0]?.message?.content ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.warn('[relationships] extraction returned non-JSON');
    return null;
  }
}

function resolveName(
  name: string,
  ownerId: string,
  selfName: string,
  roster: Map<string, string>,
): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  if (n === '我' || n === '用户' || (selfName && n === selfName)) return ownerId;
  return roster.get(n);
}

export interface RelationCtx {
  entryId: string;
  personIds: string[];
  imageDescription: string;
  transcript: { role: 'user' | 'assistant'; content: string }[];
  diaryText: string;
}

/** Post-diary hook + backfill entry point: cooccurrence edges, AI relation
 *  extraction, high-confidence write-back into the owner's relation slot. */
export async function processEntry(
  ownerId: string,
  scopeId: string,
  scopeKey: Buffer,
  ctx: RelationCtx,
): Promise<void> {
  const ids = [...new Set(ctx.personIds)].filter((id) => ID_RE.test(id));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      await upsertCooccurrence(ids[i]!, ids[j]!, ctx.entryId, scopeId, scopeKey);

  const registry = await people.listPeople(scopeId, scopeKey);
  const roster = new Map<string, string>();
  for (const p of registry) {
    if (!roster.has(p.name)) roster.set(p.name, p.id);
  }
  const selfName = registry.find((p) => p.id === ownerId)?.name ?? '';

  const material = `【照片描述】${ctx.imageDescription}
【聊天记录】
${ctx.transcript.map((m) => `${m.role === 'user' ? '用户' : '念念'}:${m.content}`).join('\n')}
【日记】
${ctx.diaryText}`;

  const raw = MOCK
    ? ((await import('./mock.ts')).MOCK_RELATIONS as Record<string, unknown>)
    : await aiJson(relationExtractionPrompt([...roster.keys()].slice(0, 50)), material, ownerId);
  // leave relationScannedAt unset on upstream failure so the next catchup retries
  if (!raw) return;

  const items = Array.isArray(raw.relations) ? raw.relations.slice(0, 6) : [];
  for (const it of items as { person1?: unknown; person2?: unknown; label?: unknown; confidence?: unknown }[]) {
    const label = typeof it?.label === 'string' ? it.label.trim().slice(0, MAX_LABEL) : '';
    const confidence = Number(it?.confidence);
    if (!label || !Number.isFinite(confidence) || confidence <= 0 || confidence > 1) continue;
    const aId = resolveName(String(it?.person1 ?? ''), ownerId, selfName, roster);
    const bId = resolveName(String(it?.person2 ?? ''), ownerId, selfName, roster);
    if (!aId || !bId || aId === bId) continue;

    await upsertAiRelation(aId, bId, label, confidence, ctx.entryId, scopeId, scopeKey);

    const targetId = aId === ownerId ? bId : bId === ownerId ? aId : null;
    if (!targetId) continue;
    const target = await people.getPerson(targetId, scopeKey);
    if (!target || target.scopeId !== scopeId) continue;
    // write-back is per-perspective: only the diary owner's own slot is touched
    const current = (target.relations[ownerId] ?? '').trim();
    const shouldWrite =
      confidence >= WRITE_BACK_OVERWRITE || (!current && confidence >= WRITE_BACK_MIN);
    if (shouldWrite && current !== label) {
      await people.updatePerson(targetId, scopeKey, (cur) => ({
        ...cur,
        relations: { ...cur.relations, [ownerId]: label },
        updatedAt: Date.now(),
      }));
      console.log(`[relationships] wrote back relation "${label}" for ${target.name}`);
    }
  }

  await store.patchEntry(ctx.entryId, { relationScannedAt: Date.now() });
}

/** Login-triggered sweep for one owner's diaries completed before relationship
 *  support existed (or while their keys were absent). Serial — one LLM call at a time. */
export async function backfillForOwner(
  ownerId: string,
  scopeId: string,
  scopeKey: Buffer,
  udk: Buffer,
): Promise<void> {
  const pending = (await store.listEntriesFor(ownerId, udk, scopeKey))
    .filter((e) => !e.relationScannedAt && e.status === 'done' && e.diaryText.trim());
  if (!pending.length) return;
  console.log(`[relationships] backfilling ${pending.length} entries for ${ownerId}`);
  for (const e of pending) {
    await processEntry(ownerId, scopeId, scopeKey, {
      entryId: e.id,
      personIds: e.people.map((p) => p.personId),
      imageDescription: e.imageDescription,
      transcript: e.chat.slice(-16),
      diaryText: e.diaryText,
    }).catch((err) => console.warn('[relationships] backfill entry failed', e.id, err));
  }
  console.log(`[relationships] backfill done for ${ownerId}`);
}

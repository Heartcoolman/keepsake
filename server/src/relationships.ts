/** File-backed person↔person relationship edges: data/relationships/<a>__<b>.json.
 *  One record per unordered pair; cooccurrence (photo co-appearance) and AI-inferred
 *  evidence share the record. label === '' means cooccurrence-only.
 *  Scoped like people: `scopeId`/`confidence` stay plaintext (confidence drives the
 *  highest-wins comparison), {label, evidence} live in a scope-key envelope. */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope, type Envelope } from './crypto.ts';
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

interface StoredRelationship {
  id: string;
  a: string;
  b: string;
  scopeId: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  enc: Envelope | null;
  legacy: { label: string; evidence: RelationEvidence[] } | null;
}

let index: Map<string, StoredRelationship> | null = null;
let indexLoad: Promise<Map<string, StoredRelationship>> | null = null;
const enqueue = createKeyedQueue();

const pairId = (x: string, y: string): string => {
  const [a, b] = [x, y].sort();
  return `${a}__${b}`;
};

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

function normalizeRelationship(raw: unknown): Relationship | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.a !== 'string' || !ID_RE.test(value.a)) return null;
  if (typeof value.b !== 'string' || !ID_RE.test(value.b)) return null;
  if (value.a === value.b) return null;
  const [a, b] = [value.a, value.b].sort() as [string, string];
  const confidence = Number(value.confidence);
  return {
    id: `${a}__${b}`,
    a,
    b,
    scopeId: typeof value.scopeId === 'string' && ID_RE.test(value.scopeId) ? value.scopeId : '',
    label: typeof value.label === 'string' ? value.label.trim().slice(0, MAX_LABEL) : '',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    evidence: normalizeEvidence(value.evidence),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

function parseStored(raw: unknown): StoredRelationship | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (isEnvelope(value.enc)) {
    const shell = normalizeRelationship({ ...value, label: 'x', evidence: [] });
    if (!shell) return null;
    return {
      id: shell.id,
      a: shell.a,
      b: shell.b,
      scopeId: shell.scopeId,
      confidence: shell.confidence,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      enc: value.enc,
      legacy: null,
    };
  }
  const full = normalizeRelationship(value);
  if (!full) return null;
  return {
    id: full.id,
    a: full.a,
    b: full.b,
    scopeId: full.scopeId,
    confidence: full.confidence,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    enc: null,
    legacy: { label: full.label, evidence: full.evidence },
  };
}

function decryptStored(stored: StoredRelationship, key: Buffer | undefined): Relationship {
  let content: { label: string; evidence: RelationEvidence[] };
  if (stored.legacy) {
    content = stored.legacy;
  } else {
    if (!key) throw Object.assign(new Error('relationship content locked'), { status: 423 });
    const raw = decryptJson<Record<string, unknown>>(stored.enc!, key);
    content = {
      label: typeof raw.label === 'string' ? raw.label.trim().slice(0, MAX_LABEL) : '',
      evidence: normalizeEvidence(raw.evidence),
    };
  }
  return {
    id: stored.id,
    a: stored.a,
    b: stored.b,
    scopeId: stored.scopeId,
    confidence: stored.confidence,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...content,
  };
}

function toStored(r: Relationship, key: Buffer): StoredRelationship {
  return {
    id: r.id,
    a: r.a,
    b: r.b,
    scopeId: r.scopeId,
    confidence: r.confidence,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    enc: encryptJson({ label: r.label, evidence: r.evidence }, key),
    legacy: null,
  };
}

function diskJson(stored: StoredRelationship): string {
  const { legacy, ...rest } = stored;
  if (legacy) {
    const { enc: _enc, ...structural } = rest;
    return JSON.stringify({ ...structural, ...legacy });
  }
  return JSON.stringify(rest);
}

async function writeStoredAtomic(stored: StoredRelationship): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeAtomic(DIR + stored.id + '.json', diskJson(stored));
}

async function load(): Promise<Map<string, StoredRelationship>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, StoredRelationship>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const r = parseStored(JSON.parse(await readFile(DIR + f, 'utf8')));
          if (!r) throw new Error('invalid relationship');
          map.set(r.id, r);
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
  return [...(await load()).values()]
    .filter((r) => r.scopeId === scopeId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => decryptStored(r, key));
}

export async function listLegacyRelationshipIds(scopeId?: string): Promise<string[]> {
  return [...(await load()).values()]
    .filter((r) => !!r.legacy && (!scopeId || r.scopeId === scopeId))
    .map((r) => r.id);
}

/** Structural scope check without a key (used by the scoped delete route). */
export async function getRelationshipScope(id: string): Promise<string | undefined> {
  return (await load()).get(id)?.scopeId;
}

export async function deleteRelationship(id: string): Promise<boolean> {
  return enqueue(id, async () => {
    const map = await load();
    if (!map.has(id)) return false;
    await rm(DIR + id + '.json', { force: true });
    map.delete(id);
    return true;
  });
}

/** Ops purge / family dissolution: remove every edge in a scope (no key needed). */
export async function deleteScopeData(scopeId: string): Promise<number> {
  let removed = 0;
  for (const r of [...(await load()).values()].filter((r) => r.scopeId === scopeId)) {
    if (await deleteRelationship(r.id)) removed++;
  }
  return removed;
}

/** Assign a scope to a legacy row without touching its plaintext content. */
export async function assignScope(id: string, scopeId: string): Promise<void> {
  await enqueue(id, async () => {
    const map = await load();
    const current = map.get(id);
    if (!current || current.scopeId === scopeId) return;
    const next: StoredRelationship = { ...current, scopeId };
    await writeStoredAtomic(next);
    map.set(id, next);
  });
}

/** Lazy at-rest migration of one legacy row. */
export async function encryptRelationshipRecord(id: string, key: Buffer): Promise<boolean> {
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
  for (const id of [...(await load()).values()].filter((r) => r.scopeId === scopeId).map((r) => r.id)) {
    await enqueue(id, async () => {
      const map = await load();
      const current = map.get(id);
      if (!current || current.scopeId !== scopeId) return;
      const stored = toStored(decryptStored(current, oldKey), newKey);
      await writeStoredAtomic(stored);
      map.set(id, stored);
    });
  }
}

/** Read-modify-write one pair record under its lock; creates the record when absent. */
async function upsertPair(
  x: string,
  y: string,
  scopeId: string,
  key: Buffer,
  mutate: (cur: Relationship) => Relationship | null,
): Promise<void> {
  const id = pairId(x, y);
  await enqueue(id, async () => {
    const map = await load();
    const now = Date.now();
    const [a, b] = [x, y].sort() as [string, string];
    const existing = map.get(id);
    const cur: Relationship = existing
      ? decryptStored(existing, key)
      : { id, a, b, scopeId, label: '', confidence: 0, evidence: [], createdAt: now, updatedAt: now };
    const mutated = mutate(cur);
    if (!mutated) return;
    const next = normalizeRelationship({ ...mutated, scopeId });
    if (!next || next.id !== id) throw new Error('invalid relationship update');
    const stored = toStored(next, key);
    await writeStoredAtomic(stored);
    map.set(id, stored);
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

/** Keep edges consistent when a person is merged (targetId set) or deleted. */
export async function rewriteRelationshipRefs(
  fromId: string,
  targetId: string | undefined,
  key: Buffer,
): Promise<void> {
  const map = await load();
  const touched = [...map.values()].filter((r) => r.a === fromId || r.b === fromId);
  for (const r of touched) {
    if (!targetId) {
      await deleteRelationship(r.id);
      continue;
    }
    const other = r.a === fromId ? r.b : r.a;
    if (other === targetId) {
      // merging both endpoints into one person — a self-pair is meaningless
      await deleteRelationship(r.id);
      continue;
    }
    const newId = pairId(targetId, other);
    // stable lock order across both pair keys, same trick as people.mergePeople
    const [first, second] = [r.id, newId].sort() as [string, string];
    await enqueue(first, () => enqueue(second, async () => {
      const oldStored = map.get(r.id);
      if (!oldStored) return;
      const old = decryptStored(oldStored, key);
      const existingStored = map.get(newId);
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
        id: newId,
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
      const stored = toStored(next, key);
      await writeStoredAtomic(stored);
      await rm(DIR + old.id + '.json', { force: true });
      map.set(newId, stored);
      map.delete(old.id);
    }));
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
  const pending = (await store.listEntriesFor(ownerId, udk))
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

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as people from '../people.ts';
import * as store from '../store.ts';
import * as accounts from '../accounts.ts';
import * as relationships from '../relationships.ts';
import * as keyring from '../keyring.ts';
import { enqueueInference } from '../inferenceQueue.ts';
import { err } from './errors.ts';
import { requireKeys, requireScopeOwner, type AppEnv } from './middleware.ts';

export const peopleRoutes = new Hono<AppEnv>();

peopleRoutes.use('*', requireKeys);

/** Cap request bodies like the other mutating routes so name/relation/samples
 *  can't force an unbounded JSON parse. */
const peopleBodyLimit = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
});

type Ctx = { get: (k: 'account') => accounts.Account };

/** Scope + keys for people features. scopeKey missing (member not yet granted the
 *  family key) surfaces as the same locked state the unlock UI recovers from. */
function scopeOf(c: Ctx): { scopeId: string; scopeKey: Buffer | undefined; udk: Buffer } {
  const account = c.get('account');
  const scopeId = accounts.scopeIdOf(account);
  return { scopeId, scopeKey: keyring.getScopeKey(scopeId), udk: keyring.getUdk(account.id)! };
}

/** Only enroll samples from entries the current user owns. */
async function collectOwnedSamples(
  raw: unknown,
  ownerId: string,
  scopeId: string,
  scopeKey: Buffer,
  udk: Buffer,
): Promise<{ templates: number[][]; enrolledFrom: { entryId: string; faceIndex: number }[] }> {
  const templates: number[][] = [];
  const enrolledFrom: { entryId: string; faceIndex: number }[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { templates, enrolledFrom };
  const face = await import('../face.ts');
  for (const s of raw.slice(0, 10) as { entryId?: unknown; faceIndex?: unknown }[]) {
    const entryId = typeof s?.entryId === 'string' ? s.entryId : '';
    const faceIndex = Number(s?.faceIndex) || 0;
    if (!store.validId(entryId)) continue;
    const entry = await store.getEntry(entryId);
    if (!store.isOwnedBy(entry, ownerId)) continue;
    // Cache misses run ONNX inference — go through the shared gate like every
    // other inference path so concurrent requests cannot stack CPU work.
    const emb = await enqueueInference(() =>
      face.embeddingFor(entryId, faceIndex, scopeId, scopeKey, udk),
    );
    if (emb) {
      templates.push(emb);
      enrolledFrom.push({ entryId, faceIndex });
    }
  }
  return { templates, enrolledFrom };
}

/** Template growth can reshuffle greedy assignment anywhere in the scope, so the
 *  rescan stays full-scope — but runs in the background, off the request path. */
const scheduleRescan = (scopeId: string, scopeKey: Buffer): void => {
  void import('../face.ts')
    .then((face) => face.scheduleRescan(scopeId, scopeKey))
    .catch(() => {});
};

peopleRoutes.get('/people', async (c) => {
  // scope-shared directory; relation resolved to the caller's perspective
  const viewerId = c.get('account').id;
  const { scopeId, scopeKey } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  return c.json({
    items: (await people.listPeople(scopeId, scopeKey)).map((p) => people.toDTO(p, viewerId)),
  });
});

peopleRoutes.post('/people', peopleBodyLimit, async (c) => {
  const ownerId = c.get('account').id;
  const { scopeId, scopeKey, udk } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const b = await c.req.json<{
    name?: unknown;
    relation?: unknown;
    isUser?: unknown;
    samples?: unknown;
  }>();
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return err(c, 'VALIDATION', 'name required');
  const { templates, enrolledFrom } = await collectOwnedSamples(b.samples, ownerId, scopeId, scopeKey, udk).catch(() => ({
    templates: [] as number[][],
    enrolledFrom: [] as { entryId: string; faceIndex: number }[],
  }));

  const relInput = typeof b.relation === 'string' ? b.relation.trim() : '';
  const existing = await people.findByName(scopeId, scopeKey, name);
  if (existing) {
    const next = await people.updatePerson(existing.id, scopeKey, (cur) => ({
      ...cur,
      relations: relInput ? { ...cur.relations, [ownerId]: relInput } : cur.relations,
      isUser: cur.isUser || b.isUser === true,
      templates: [...cur.templates, ...templates],
      enrolledFrom: [...cur.enrolledFrom, ...enrolledFrom],
      updatedAt: Date.now(),
    }));
    if (!next) return err(c, 'NOT_FOUND', 'person not found');
    if (templates.length) scheduleRescan(scopeId, scopeKey);
    return c.json(people.toDTO(next, ownerId));
  }

  const now = Date.now();
  const p: people.Person = {
    id: randomUUID(),
    scopeId,
    name,
    relation: '',
    relations: relInput ? { [ownerId]: relInput } : {},
    isUser: b.isUser === true,
    createdAt: now,
    updatedAt: now,
    templates,
    enrolledFrom,
  };
  await people.putPerson(p, scopeKey);
  if (templates.length) scheduleRescan(scopeId, scopeKey);
  return c.json(people.toDTO(p, ownerId), 201);
});

peopleRoutes.patch('/people/:id', peopleBodyLimit, async (c) => {
  const id = c.req.param('id');
  if (!store.validId(id)) return err(c, 'VALIDATION', 'bad id');
  const account = c.get('account');
  const ownerId = account.id;
  const { scopeId, scopeKey, udk } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const scope = await people.getPersonScope(id);
  if (!scope || scope.scopeId !== scopeId) return err(c, 'NOT_FOUND', 'person not found');
  const cur = await people.getPerson(id, scopeKey);
  if (!cur) return err(c, 'NOT_FOUND', 'person not found');
  const b = await c.req.json<Record<string, unknown>>();
  // The directory is scope-shared, but renaming or re-flagging a person that is
  // another member's login identity is reserved to that member or the family owner.
  const requestedName = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : '';
  const changesIdentity =
    (requestedName !== '' && requestedName !== cur.name) ||
    (typeof b.isUser === 'boolean' && b.isUser !== cur.isUser);
  if (changesIdentity && !accounts.isScopeOwner(account) && account.id !== id && (await accounts.getAccount(id)))
    return err(c, 'FORBIDDEN', 'cannot modify another account-linked person');
  const added = await collectOwnedSamples(b.addSamples, ownerId, scopeId, scopeKey, udk).catch(() => ({
    templates: [] as number[][],
    enrolledFrom: [] as { entryId: string; faceIndex: number }[],
  }));
  const next = await people.updatePerson(id, scopeKey, (current) => {
    // relation edits only touch the caller's own perspective slot
    let relations = current.relations;
    if (typeof b.relation === 'string') {
      relations = { ...current.relations };
      const t = b.relation.trim();
      if (t) relations[ownerId] = t;
      else delete relations[ownerId];
    }
    return {
      ...current,
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : current.name,
      relations,
      isUser: typeof b.isUser === 'boolean' ? b.isUser : current.isUser,
      templates: [...current.templates, ...added.templates],
      enrolledFrom: [...current.enrolledFrom, ...added.enrolledFrom],
      updatedAt: Date.now(),
    };
  });
  if (!next) return err(c, 'NOT_FOUND', 'person not found');
  if (added.templates.length) scheduleRescan(scopeId, scopeKey);
  return c.json(people.toDTO(next, ownerId));
});

peopleRoutes.post('/people/:id/merge', requireScopeOwner, async (c) => {
  const id = c.req.param('id');
  if (!store.validId(id)) return err(c, 'VALIDATION', 'bad id');
  const { scopeId, scopeKey } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const { fromId } = await c.req.json<{ fromId?: unknown }>();
  if (typeof fromId !== 'string' || !store.validId(fromId) || fromId === id)
    return err(c, 'VALIDATION', 'bad fromId');
  if (await accounts.getAccount(fromId))
    return err(c, 'VALIDATION', 'cannot merge an account-linked person');
  const targetScope = await people.getPersonScope(id);
  const fromScope = await people.getPersonScope(fromId);
  if (targetScope?.scopeId !== scopeId || fromScope?.scopeId !== scopeId)
    return err(c, 'NOT_FOUND', 'person not found');
  const merged = await people.mergePeople(id, fromId, scopeKey);
  if (!merged) return err(c, 'NOT_FOUND', 'person not found');
  await store.rewritePersonRefs(fromId, id);
  await relationships.rewriteRelationshipRefs(fromId, id, scopeKey);
  if (merged.templates.length) scheduleRescan(scopeId, scopeKey);
  return c.json(people.toDTO(merged, c.get('account').id));
});

peopleRoutes.delete('/people/:id', requireScopeOwner, async (c) => {
  const id = c.req.param('id');
  if (!store.validId(id)) return err(c, 'VALIDATION', 'bad id');
  const { scopeId, scopeKey } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  if (await accounts.getAccount(id)) return err(c, 'VALIDATION', 'cannot delete an account-linked person');
  const scope = await people.getPersonScope(id);
  if (!scope || scope.scopeId !== scopeId) return err(c, 'NOT_FOUND', 'person not found');
  const cur = await people.getPerson(id, scopeKey);
  if (!cur || !(await people.deletePerson(id))) return err(c, 'NOT_FOUND', 'person not found');
  // Removing a person can only change entries where they were the assigned winner
  // (runner-up candidates are never persisted), so rescan just those.
  const affected = (await store.listEntries())
    .filter((e) => e.people.some((r) => r.personId === id))
    .map((e) => e.id);
  await store.rewritePersonRefs(id, undefined);
  await relationships.rewriteRelationshipRefs(id, undefined, scopeKey);
  if (cur.templates.length && affected.length) {
    void import('../face.ts')
      .then((face) => enqueueInference(() => face.rescanEntries(affected, scopeId, scopeKey), { priority: 'batch' }))
      .catch(() => {});
  }
  return c.json({ ok: true });
});

/** Unassigned faces only from the caller's own entries. */
peopleRoutes.get('/faces/unassigned', async (c) => {
  const ownerId = c.get('account').id;
  const { scopeId, scopeKey } = scopeOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  try {
    const face = await import('../face.ts');
    const all = await enqueueInference(() => face.unassignedClusters(scopeId, scopeKey));
    const ownerCache = new Map<string, boolean>();
    const isMine = async (entryId: string) => {
      if (ownerCache.has(entryId)) return ownerCache.get(entryId)!;
      const e = await store.getEntry(entryId);
      const ok = store.isOwnedBy(e, ownerId);
      ownerCache.set(entryId, ok);
      return ok;
    };

    const out: { faces: { entryId: string; faceIndex: number }[] }[] = [];
    for (const cluster of all) {
      const faces: { entryId: string; faceIndex: number }[] = [];
      for (const f of cluster.faces) {
        if (await isMine(f.entryId)) faces.push(f);
      }
      if (faces.length) out.push({ faces });
    }
    return c.json({ items: out });
  } catch (e) {
    console.error('[v1] unassigned faces failed', e);
    return err(c, 'UNAVAILABLE', 'face unavailable');
  }
});

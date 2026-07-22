import { Hono } from 'hono';
import * as people from '../people.ts';
import * as relationships from '../relationships.ts';
import * as accounts from '../accounts.ts';
import * as keyring from '../keyring.ts';
import { err } from './errors.ts';
import { requireKeys, requireScopeOwner, type AppEnv } from './middleware.ts';

export const relationshipRoutes = new Hono<AppEnv>();

relationshipRoutes.use('*', requireKeys);

relationshipRoutes.get('/graph', async (c) => {
  // scope-shared, same as GET /people
  const account = c.get('account');
  const me = account.id;
  const scopeId = accounts.scopeIdOf(account);
  const scopeKey = keyring.getScopeKey(scopeId);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const [ppl, stored] = await Promise.all([
    people.listPeople(scopeId, scopeKey),
    relationships.listRelationships(scopeId, scopeKey),
  ]);
  // copy before overlay — decrypted records are transient, but keep the habit
  const edges: (relationships.Relationship & { virtual?: boolean })[] = stored.map((r) => ({ ...r }));
  const byId = new Map(edges.map((e) => [e.id, e]));
  // The caller's own hand-entered perspective (Person.relations[me]) is ground
  // truth — overlay it as an edge (confidence 1, beats any AI label), not persisted.
  for (const p of ppl) {
    if (p.id === me) continue;
    const rel = people.relationFor(p, me).trim();
    if (!rel) continue;
    const [a, b] = [me, p.id].sort() as [string, string];
    const id = `${a}__${b}`;
    const hit = byId.get(id);
    if (hit) {
      if (hit.label !== rel) {
        hit.label = rel;
        hit.confidence = 1;
      }
    } else {
      const e = { id, a, b, scopeId, label: rel, confidence: 1, evidence: [], createdAt: p.createdAt, updatedAt: p.updatedAt, virtual: true };
      edges.push(e);
      byId.set(id, e);
    }
  }
  const degree = new Map<string, number>();
  for (const r of edges) {
    degree.set(r.a, (degree.get(r.a) ?? 0) + 1);
    degree.set(r.b, (degree.get(r.b) ?? 0) + 1);
  }
  return c.json({
    nodes: ppl.map((p) => ({ ...people.toDTO(p, me), degree: degree.get(p.id) ?? 0 })),
    edges,
  });
});

relationshipRoutes.delete('/relationships/:id', requireScopeOwner, async (c) => {
  const account = c.get('account');
  const id = c.req.param('id');
  const scope = await relationships.getRelationshipScope(id);
  if (!scope || scope !== accounts.scopeIdOf(account))
    return err(c, 'NOT_FOUND', 'relationship not found');
  const ok = await relationships.deleteRelationship(id);
  return ok ? c.json({ ok: true }) : err(c, 'NOT_FOUND', 'relationship not found');
});

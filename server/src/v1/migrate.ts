/** One-time / idempotent data migrations, marker-file gated. Structural only —
 *  they run at boot with no keys in the keyring, so they never touch content. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as store from '../store.ts';
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as people from '../people.ts';
import * as relationships from '../relationships.ts';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const MARKER = DATA_DIR + 'migration-v1.json';
const FAMILY_MARKER = DATA_DIR + 'migration-family.json';
const PLAN_MARKER = DATA_DIR + 'migration-plan.json';

interface Marker {
  version: 1;
  completedAt: number;
  entriesRewritten: number;
}

export async function runV1Migration(): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(MARKER, 'utf8')) as Marker;
    if (existing.version === 1) return;
  } catch {
    // not migrated yet
  }

  let rewritten = 0;
  for (const entry of await store.listEntries()) {
    const owner = entry.ownerId || entry.userId || '';
    // Force dual-write so both fields exist on disk even for pre-ownerId rows
    if (entry.ownerId && entry.userId && entry.ownerId === entry.userId) continue;
    const next = await store.patchEntry(entry.id, { ownerId: owner, userId: owner });
    if (next) rewritten++;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const marker: Marker = { version: 1, completedAt: Date.now(), entriesRewritten: rewritten };
  await writeFile(MARKER, JSON.stringify(marker, null, 2));
  console.log(`[migrate-v1] rewritten ${rewritten} entries; marker written`);
}

interface FamilyMarker {
  version: 1;
  completedAt: number;
  familyId: string | null;
}

/** Single-household → multi-family tenancy: put every pre-existing account into
 *  one default family (earliest admin becomes the family-type owner), stamp
 *  familyId on entries and scopeId on people/relationships. No keys needed. */
export async function runFamilyMigration(): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(FAMILY_MARKER, 'utf8')) as FamilyMarker;
    if (existing.version === 1) return;
  } catch {
    // not migrated yet
  }

  const all = await accounts.listAccounts();
  let familyId: string | null = null;

  if (all.length > 0) {
    const owner =
      all.filter((a) => a.role === 'admin' && !a.disabled).sort((a, b) => a.createdAt - b.createdAt)[0] ??
      all[0]!;
    const family = await families.createFamilyUnsealed('我的家庭', owner.id);
    familyId = family.id;

    for (const account of all) {
      await accounts.updateAccount(account.id, (cur) => ({
        ...cur,
        familyId: family.id,
        accountType: cur.id === owner.id ? 'family' : 'personal',
        role: cur.id === owner.id ? 'admin' : 'member',
        updatedAt: Date.now(),
      }));
    }

    for (const entry of await store.listEntries()) {
      if (entry.familyId) continue;
      await store.patchEntry(entry.id, { familyId: family.id });
    }
    for (const p of await people.listScopes()) {
      if (!p.scopeId) await people.assignScope(p.id, family.id);
    }
    for (const id of await relationships.listLegacyRelationshipIds()) {
      const scope = await relationships.getRelationshipScope(id);
      if (!scope) await relationships.assignScope(id, family.id);
    }
    console.log(`[migrate-family] default family ${family.id} (owner ${owner.username}), ${all.length} account(s)`);
  }

  await mkdir(DATA_DIR, { recursive: true });
  const marker: FamilyMarker = { version: 1, completedAt: Date.now(), familyId };
  await writeFile(FAMILY_MARKER, JSON.stringify(marker, null, 2));
}

interface PlanMarker {
  version: 1;
  completedAt: number;
  grandfathered: number;
}

/**
 * Grandfathering for the introduction of paid plans.
 *
 * Before quotas existed every account was unmetered and every account could build the
 * annual book. Shipping the gate with everyone still reading `plan: "free"` would silently
 * take both away from libraries that already had them, so accounts present at the moment
 * the gate arrives are moved to the plan that matches what they already had. Accounts
 * created afterwards start on `free`, which is the point of the gate.
 *
 * A deployment whose license does not grant `family` degrades these to `free` on read
 * (planOf), so this cannot hand out more than the token allows.
 */
export async function runPlanMigration(): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(PLAN_MARKER, 'utf8')) as PlanMarker;
    if (existing.version === 1) return;
  } catch {
    // not migrated yet
  }

  let grandfathered = 0;
  for (const account of await accounts.listAccounts()) {
    if (account.plan !== 'free') continue;
    const updated = await accounts.updateAccount(account.id, (cur) => ({
      ...cur,
      plan: 'family',
      updatedAt: Date.now(),
    }));
    if (updated) grandfathered++;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const marker: PlanMarker = { version: 1, completedAt: Date.now(), grandfathered };
  await writeFile(PLAN_MARKER, JSON.stringify(marker, null, 2));
  console.log(
    `[migrate-plan] grandfathered ${grandfathered} pre-billing account(s) to the family plan; ` +
      'new accounts follow the deployment license',
  );
}

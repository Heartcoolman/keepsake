/** Login-triggered catchup. Boot-time sweeps that used to read plaintext cannot
 *  run any more (no keys at boot) — instead, whenever an account's keys enter the
 *  keyring this module: converts a pending removed-member person bundle, grants
 *  the family key to members still missing it, lazily rewrites that account's
 *  legacy plaintext data into the encrypted at-rest shape, and re-runs the
 *  face/relationship indexing that was skipped while keys were absent. */
import { sealToPub, openSealed, isSealedBox } from './crypto.ts';
import * as keyring from './keyring.ts';
import * as accounts from './accounts.ts';
import * as store from './store.ts';
import * as people from './people.ts';
import * as relationships from './relationships.ts';
import * as memory from './memory.ts';
import { migrateLegacyAnalyzeCaches } from './analyzeCache.ts';
import { enqueueInference } from './inferenceQueue.ts';

const INFERENCE_DISABLED = process.env.INFERENCE_DISABLED === '1';

const running = new Set<string>();
/** scopes consolidated once per process — idempotent but not free */
const consolidatedScopes = new Set<string>();

/** /auth/me surfaces this so clients (and the NAS migration) can wait for completion. */
export async function isMigrationPending(accountId: string): Promise<boolean> {
  if (running.has(accountId)) return true;
  return (await store.listLegacyEntryIds(accountId)).length > 0;
}

export function startDeferredTasks(): void {
  keyring.onUnlock((event) => {
    if (running.has(event.accountId)) return;
    running.add(event.accountId);
    void runCatchup(event)
      .catch((e) => console.warn('[deferred] catchup failed for', event.accountId, e))
      .finally(() => running.delete(event.accountId));
  });
}

async function runCatchup(event: keyring.UnlockEvent): Promise<void> {
  await convertPendingPerson(event);
  if (event.fk && event.familyId) await grantFamilyKey(event.familyId, event.fk);

  const scopeKey = event.fk ?? event.udk;
  await encryptOwnerData(event);
  await encryptScopeData(event.scopeId, scopeKey);
  await consolidateScope(event.scopeId, scopeKey);

  if (!INFERENCE_DISABLED) await faceCatchup(event, scopeKey);
  await relationships
    .backfillForOwner(event.accountId, event.scopeId, scopeKey, event.udk)
    .catch((e) => console.warn('[deferred] relationship backfill failed:', e));
}

/** Removed from a family while offline: the isUser person arrives sealed to our
 *  pubkey — decrypt it back into the personal scope. */
async function convertPendingPerson(event: keyring.UnlockEvent): Promise<void> {
  const account = await accounts.getAccount(event.accountId);
  if (!account?.pendingPerson || !account.pubKey || !isSealedBox(account.pendingPerson)) return;
  try {
    const bundle = JSON.parse(
      openSealed(account.pendingPerson, event.priv, Buffer.from(account.pubKey, 'base64url')).toString('utf8'),
    ) as people.Person;
    await people.putPerson({ ...bundle, scopeId: event.accountId, updatedAt: Date.now() }, event.udk);
    await accounts.updateAccount(event.accountId, (cur) => ({
      ...cur,
      pendingPerson: null,
      updatedAt: Date.now(),
    }));
    console.log(`[deferred] restored personal person record for ${event.accountId}`);
  } catch (e) {
    console.warn('[deferred] pending person conversion failed:', e);
  }
}

/** Migration-era repair: members of the pre-existing default family have no
 *  invite carrying the FK — seal it to their pubkey once any FK holder is online. */
async function grantFamilyKey(familyId: string, fk: Buffer): Promise<void> {
  for (const member of await accounts.listAccounts(familyId)) {
    if (member.encFk || !member.pubKey) continue;
    await accounts.updateAccount(member.id, (cur) => ({
      ...cur,
      encFk: sealToPub(Buffer.from(cur.pubKey!, 'base64url'), fk),
      updatedAt: Date.now(),
    }));
    console.log(`[deferred] granted family key to ${member.username}`);
  }
}

/** Rewrite this owner's legacy plaintext records (entries+blobs, memory bank,
 *  monthly reviews, analyze/depth caches) into the encrypted at-rest shape. */
async function encryptOwnerData(event: keyring.UnlockEvent): Promise<void> {
  const legacyIds = await store.listLegacyEntryIds(event.accountId);
  if (legacyIds.length) console.log(`[deferred] encrypting ${legacyIds.length} legacy entries for ${event.accountId}`);
  const depth = INFERENCE_DISABLED ? null : await import('./depth.ts').catch(() => null);
  for (const id of legacyIds) {
    try {
      await store.encryptEntryRecord(id, event.udk);
      const entry = await store.getEntry(id);
      if (entry?.imageHash && depth)
        await depth.migrateLegacyDepthCache(entry.imageHash, event.accountId, event.udk);
    } catch (e) {
      console.warn('[deferred] entry encryption failed', id, e);
    }
  }
  await memory.encryptUserData(event.accountId, event.udk).catch(() => false);
  await store.encryptMonthlyReviews(event.accountId, event.udk).catch(() => 0);
  await migrateLegacyAnalyzeCaches(event.accountId, event.udk).catch(() => undefined);
}

/** Encrypt the scope's legacy people/relationship rows (needs the scope key). */
async function encryptScopeData(scopeId: string, scopeKey: Buffer): Promise<void> {
  for (const id of await people.listLegacyPersonIds(scopeId)) {
    await people
      .encryptPersonRecord(id, scopeKey)
      .catch((e) => console.warn('[deferred] person encryption failed', id, e));
  }
  for (const id of await relationships.listLegacyRelationshipIds(scopeId)) {
    await relationships
      .encryptRelationshipRecord(id, scopeKey)
      .catch((e) => console.warn('[deferred] relationship encryption failed', id, e));
  }
}

/** Duplicate-name consolidation, once per scope per process (was a boot task). */
async function consolidateScope(scopeId: string, scopeKey: Buffer): Promise<void> {
  if (consolidatedScopes.has(scopeId)) return;
  consolidatedScopes.add(scopeId);
  try {
    const accountIds = new Set((await accounts.listAccounts()).map((a) => a.id));
    const { absorbed, merges } = await people.consolidateDuplicateNames(scopeId, scopeKey, accountIds);
    if (!absorbed) return;
    console.log(`[people] consolidated ${absorbed} duplicate name(s) in scope ${scopeId}`);
    for (const merge of merges) {
      for (const fromId of merge.absorbedIds) {
        await store.rewritePersonRefs(fromId, merge.keeperId).catch(() => undefined);
        await relationships.rewriteRelationshipRefs(fromId, merge.keeperId, scopeKey).catch(() => undefined);
      }
    }
    if (!INFERENCE_DISABLED) {
      const face = await import('./face.ts');
      face.scheduleRescan(scopeId, scopeKey);
    }
  } catch (e) {
    console.warn('[deferred] consolidation failed for scope', scopeId, e);
  }
}

/** Scan this owner's unscanned entries + force legacy face-cache/thumb adoption. */
async function faceCatchup(event: keyring.UnlockEvent, scopeKey: Buffer): Promise<void> {
  const face = await import('./face.ts').catch(() => null);
  if (!face) return;
  for (const entry of await store.listEntries()) {
    if (entry.ownerId !== event.accountId && entry.userId !== event.accountId) continue;
    if (store.entryScopeId(entry) !== event.scopeId) continue;
    try {
      if (!entry.faceScannedAt) {
        const image = await store.readEntryBlob(entry.id, 'img', event.udk);
        if (image)
          await enqueueInference(() => face.scanEntry(entry.id, image, event.scopeId, scopeKey), {
            priority: 'batch',
          });
      } else if (entry.imageHash) {
        // reads migrate legacy bare-hash caches/thumbs into the scoped encrypted key
        await face.readFaceCache(event.scopeId, entry.imageHash, scopeKey);
        await face.migrateLegacyThumbs(entry.imageHash, event.scopeId, scopeKey);
      }
    } catch (e) {
      console.warn('[deferred] face catchup failed for', entry.id, e);
    }
  }
}

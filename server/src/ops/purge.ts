/** Ops-side destructive operations. Everything here is structural: the console
 *  holds no user keys, so nothing is decrypted or re-encrypted — abandoned
 *  ciphertext is simply deleted. */
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as store from '../store.ts';
import * as memory from '../memory.ts';
import * as usage from '../usage.ts';
import * as analyzeCache from '../analyzeCache.ts';
import * as depth from '../depth.ts';
import * as people from '../people.ts';
import * as relationships from '../relationships.ts';
import * as keyring from '../keyring.ts';

async function dropFaceCaches(scopeId: string): Promise<void> {
  const face = await import('../face.ts').catch(() => null);
  if (face) await face.deleteScopeCaches(scopeId);
}

/** Hard-delete a standalone account and every file keyed by it. The caller has
 *  already verified familyId === null — a family member cannot be purged here
 *  because departure requires an FK rotation only members can perform. */
export async function purgeAccountData(account: accounts.Account): Promise<void> {
  const id = account.id;
  await store.deleteOwnerData(id);
  await memory.deleteUserData(id);
  await usage.deleteAccountUsage(id);
  await analyzeCache.clearAnalyzeCaches(id);
  await depth.clearDepthCaches(id);
  await people.deleteScopeData(id);
  await relationships.deleteScopeData(id);
  await dropFaceCaches(id);
  for (const invite of await families.listInvitesForAccount(id)) {
    await families.deleteInvite(invite.id);
  }
  keyring.wipe(id);
  await accounts.deleteAccount(id);
}

/** Emergency dissolution. The family key is neither needed nor available: all
 *  scope-encrypted data — shared people INCLUDING every member's isUser face
 *  enrollment, graph edges, face caches — is destroyed for good, and members
 *  fall back to standalone accounts (their dormant personal scopes revive).
 *  Idempotent: the family record is deleted last, so a crashed run is finished
 *  by simply invoking it again with the same id. */
export async function dissolveFamily(familyId: string): Promise<{ members: number }> {
  // Invites carry the (now abandoned) FK.
  for (const invite of await families.listInvitesForFamily(familyId)) {
    await families.deleteInvite(invite.id);
  }

  await people.deleteScopeData(familyId);
  await relationships.deleteScopeData(familyId);
  await dropFaceCaches(familyId);

  // Entries back to their owners' personal scopes; person refs pointed at the
  // deleted shared registry, so clear them and force a rescan on next login.
  for (const entry of await store.listEntries()) {
    if (entry.familyId !== familyId) continue;
    await store.patchEntry(entry.id, {
      familyId: null,
      people: [],
      unknownFaces: 0,
      faceScannedAt: 0,
    });
  }

  const members = await accounts.listAccounts(familyId);
  for (const member of members) {
    await accounts.updateAccount(member.id, (cur) => ({
      ...cur,
      familyId: null,
      encFk: null,
      updatedAt: Date.now(),
    }));
    keyring.setFamily(member.id, null);
  }

  await families.deleteFamily(familyId);
  keyring.dropFamilyKey(familyId);
  console.log(`[ops] family ${familyId} dissolved (${members.length} member(s) detached)`);
  return { members: members.length };
}

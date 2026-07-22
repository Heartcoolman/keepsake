/** Family membership: invites (family account → personal accounts), accept /
 *  decline, leave, remove. An invite carries the family key sealed to the
 *  invitee's public key, so acceptance never needs both parties online.
 *  Departures rotate the family key and re-encrypt all family-scoped data. */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as people from '../people.ts';
import * as relationships from '../relationships.ts';
import * as store from '../store.ts';
import * as keyring from '../keyring.ts';
import { randomKey, sealToPub } from '../crypto.ts';
import { err } from './errors.ts';
import { requireAuth, type AppEnv } from './middleware.ts';

export const familyRoutes = new Hono<AppEnv>();

familyRoutes.use('*', requireAuth);

const familyBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
});

function isFamilyOwner(account: accounts.Account): boolean {
  return account.accountType === 'family' && account.familyId !== null;
}

// ---------- info ----------

familyRoutes.get('/family', async (c) => {
  const account = c.get('account');
  if (!account.familyId) return c.json({ family: null, members: [], invites: [] });
  const family = await families.getFamily(account.familyId);
  if (!family) return c.json({ family: null, members: [], invites: [] });
  const members = (await accounts.listAccounts(family.id)).map(accounts.toPublic);
  const invites = isFamilyOwner(account)
    ? await Promise.all(
        (await families.listInvitesForFamily(family.id)).map(async (i) => ({
          id: i.id,
          inviteeId: i.inviteeId,
          inviteeName: (await accounts.getAccount(i.inviteeId))?.displayName ?? '',
          createdAt: i.createdAt,
        })),
      )
    : [];
  return c.json({
    family: { id: family.id, name: family.name, ownerId: family.ownerId },
    members,
    invites,
  });
});

/** A family account without a family (ops dissolved it) starts a fresh one.
 *  Mirrors invite-acceptance: identity person + own entries move into the new
 *  scope, entries re-scan against the (empty) family registry. */
familyRoutes.post('/family', familyBodyLimit, async (c) => {
  const account = c.get('account');
  if (account.accountType !== 'family') return err(c, 'FORBIDDEN', 'family account required');
  if (account.familyId) return err(c, 'CONFLICT', 'already owns a family');
  const udk = keyring.getUdk(account.id);
  const priv = keyring.getPriv(account.id);
  if (!udk || !priv || !account.pubKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');

  const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const family = await families.createFamily(
    typeof body.name === 'string' && body.name.trim() ? body.name : `${account.displayName}的家庭`,
    account.id,
  );
  const fk = randomKey();
  const updated = (await accounts.updateAccount(account.id, (cur) => ({
    ...cur,
    familyId: family.id,
    encFk: sealToPub(Buffer.from(cur.pubKey!, 'base64url'), fk),
    updatedAt: Date.now(),
  })))!;
  keyring.setFamily(account.id, family.id);
  keyring.putFamilyKey(family.id, fk);

  const mine = await people.getPersonScope(account.id);
  if (mine && mine.scopeId === account.id) {
    await people.movePersonToScope(account.id, udk, family.id, fk);
  } else if (!mine) {
    const now = Date.now();
    await people.putPerson(
      {
        id: account.id,
        scopeId: family.id,
        name: account.displayName,
        relation: '本人',
        relations: {},
        isUser: true,
        createdAt: now,
        updatedAt: now,
        templates: [],
        enrolledFrom: [],
      },
      fk,
    );
  }
  for (const entry of await store.listEntries()) {
    if (entry.ownerId !== account.id && entry.userId !== account.id) continue;
    await store.patchEntry(entry.id, {
      familyId: family.id,
      people: [],
      unknownFaces: 0,
      faceScannedAt: 0,
    });
  }
  keyring.notifyUnlock({
    accountId: account.id,
    familyId: family.id,
    scopeId: family.id,
    udk,
    priv,
    fk,
  });
  return c.json(
    {
      ok: true,
      family: { id: family.id, name: family.name, ownerId: family.ownerId },
      user: accounts.toPublic(updated),
    },
    201,
  );
});

// ---------- invites (owner side) ----------

familyRoutes.post('/family/invites', familyBodyLimit, async (c) => {
  const account = c.get('account');
  if (!isFamilyOwner(account)) return err(c, 'FORBIDDEN', 'family owner required');
  const familyId = account.familyId!;
  const fk = keyring.getFamilyKey(familyId);
  if (!fk) return err(c, 'E_KEYS_LOCKED', 'unlock required');

  const body = await c.req.json<{ username?: unknown }>();
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username) return err(c, 'VALIDATION', 'username required');
  const target = await accounts.findByUsername(username);
  if (!target || target.disabled || target.id === account.id)
    return err(c, 'NOT_FOUND', 'user not found');
  if (target.accountType !== 'personal')
    return err(c, 'VALIDATION', 'only personal accounts can be invited');
  if (target.familyId)
    return err(c, 'CONFLICT', 'user already belongs to a family');
  if (!target.pubKey)
    return err(c, 'CONFLICT', 'user has not logged in since the upgrade — ask them to log in once first');
  const pending = await families.listInvitesForAccount(target.id);
  if (pending.some((i) => i.familyId === familyId))
    return err(c, 'CONFLICT', 'invite already pending');

  const invite = await families.createInvite({
    familyId,
    inviterId: account.id,
    inviteeId: target.id,
    sealedFk: sealToPub(Buffer.from(target.pubKey, 'base64url'), fk),
  });
  return c.json(
    { id: invite.id, inviteeId: target.id, inviteeName: target.displayName, createdAt: invite.createdAt },
    201,
  );
});

familyRoutes.delete('/family/invites/:id', async (c) => {
  const account = c.get('account');
  if (!isFamilyOwner(account)) return err(c, 'FORBIDDEN', 'family owner required');
  const invite = await families.getInvite(c.req.param('id'));
  if (!invite || invite.familyId !== account.familyId) return err(c, 'NOT_FOUND', 'invite not found');
  await families.deleteInvite(invite.id);
  return c.json({ ok: true });
});

// ---------- invites (invitee side) ----------

familyRoutes.get('/me/invites', async (c) => {
  const account = c.get('account');
  const invites = await Promise.all(
    (await families.listInvitesForAccount(account.id)).map(async (i) => {
      const family = await families.getFamily(i.familyId);
      const inviter = await accounts.getAccount(i.inviterId);
      return {
        id: i.id,
        familyId: i.familyId,
        familyName: family?.name ?? '',
        inviterName: inviter?.displayName ?? '',
        createdAt: i.createdAt,
      };
    }),
  );
  return c.json({ items: invites });
});

familyRoutes.post('/me/invites/:id/accept', async (c) => {
  let account = c.get('account');
  const invite = await families.getInvite(c.req.param('id'));
  if (!invite || invite.inviteeId !== account.id) return err(c, 'NOT_FOUND', 'invite not found');
  if (account.accountType !== 'personal' || account.familyId)
    return err(c, 'CONFLICT', 'already in a family');
  const family = await families.getFamily(invite.familyId);
  if (!family) {
    await families.deleteInvite(invite.id);
    return err(c, 'NOT_FOUND', 'family no longer exists');
  }
  const udk = keyring.getUdk(account.id);
  const priv = keyring.getPriv(account.id);
  if (!udk || !priv || !account.pubKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');

  let fk: Buffer;
  try {
    const { openSealed } = await import('../crypto.ts');
    fk = openSealed(invite.sealedFk, priv, Buffer.from(account.pubKey, 'base64url'));
  } catch {
    // stale grant (family key rotated after this invite was sent)
    await families.deleteInvite(invite.id);
    return err(c, 'CONFLICT', 'invite expired — ask for a new one');
  }

  account = (await accounts.updateAccount(account.id, (cur) => ({
    ...cur,
    familyId: invite.familyId,
    encFk: invite.sealedFk,
    updatedAt: Date.now(),
  })))!;
  keyring.setFamily(account.id, invite.familyId);
  keyring.putFamilyKey(invite.familyId, fk);

  // My identity person follows me into the family scope; other personal-scope
  // people stay dormant until I leave. Entries re-scan against the family registry.
  const mine = await people.getPersonScope(account.id);
  if (mine && mine.scopeId === account.id) {
    await people.movePersonToScope(account.id, udk, invite.familyId, fk);
  } else if (!mine) {
    const now = Date.now();
    await people.putPerson(
      {
        id: account.id,
        scopeId: invite.familyId,
        name: account.displayName,
        relation: '本人',
        relations: {},
        isUser: true,
        createdAt: now,
        updatedAt: now,
        templates: [],
        enrolledFrom: [],
      },
      fk,
    );
  }
  for (const entry of await store.listEntries()) {
    if (entry.ownerId !== account.id && entry.userId !== account.id) continue;
    await store.patchEntry(entry.id, {
      familyId: invite.familyId,
      people: [],
      unknownFaces: 0,
      faceScannedAt: 0,
    });
  }
  await families.deleteInvite(invite.id);

  // Kick the catchup (face rescan in the new scope, etc.).
  keyring.notifyUnlock({
    accountId: account.id,
    familyId: invite.familyId,
    scopeId: invite.familyId,
    udk,
    priv,
    fk,
  });

  return c.json({
    ok: true,
    family: { id: family.id, name: family.name, ownerId: family.ownerId },
    user: accounts.toPublic(account),
  });
});

familyRoutes.post('/me/invites/:id/decline', async (c) => {
  const account = c.get('account');
  const invite = await families.getInvite(c.req.param('id'));
  if (!invite || invite.inviteeId !== account.id) return err(c, 'NOT_FOUND', 'invite not found');
  await families.deleteInvite(invite.id);
  return c.json({ ok: true });
});

// ---------- departure (leave / remove) ----------

/** Detach a member and rotate the family key so departed members (and stale
 *  invites) cannot read anything written afterwards. */
async function removeMember(
  family: families.Family,
  target: accounts.Account,
  oldFk: Buffer,
): Promise<void> {
  // 1. The member's identity person returns to their personal scope. If their UDK
  //    is not in the keyring (offline removal), seal the bundle to their pubkey —
  //    their next login converts it back (deferredTasks.convertPendingPerson).
  const mine = await people.getPersonScope(target.id);
  if (mine && mine.scopeId === family.id) {
    const targetUdk = keyring.getUdk(target.id);
    if (targetUdk) {
      await people.movePersonToScope(target.id, oldFk, target.id, targetUdk);
    } else if (target.pubKey) {
      const person = await people.getPerson(target.id, oldFk);
      if (person) {
        await accounts.updateAccount(target.id, (cur) => ({
          ...cur,
          pendingPerson: sealToPub(Buffer.from(cur.pubKey!, 'base64url'), Buffer.from(JSON.stringify(person), 'utf8')),
          updatedAt: Date.now(),
        }));
      }
      await people.deletePerson(target.id);
    } else {
      await people.deletePerson(target.id);
    }
  }

  // 2. Drop the member's graph edges + perspective labels from the family scope.
  await relationships.rewriteRelationshipRefs(target.id, undefined, oldFk).catch(() => undefined);
  for (const p of await people.listPeople(family.id, oldFk)) {
    if (!p.relations[target.id]) continue;
    await people.updatePerson(p.id, oldFk, (cur) => {
      const relations = { ...cur.relations };
      delete relations[target.id];
      return { ...cur, relations, updatedAt: Date.now() };
    });
  }

  // 3. Their entries fall back to the personal scope; face links pointed at
  //    family people, so reset them for a rescan on their next login.
  for (const entry of await store.listEntries()) {
    if (entry.ownerId !== target.id && entry.userId !== target.id) continue;
    if (entry.familyId !== family.id) continue;
    await store.patchEntry(entry.id, {
      familyId: null,
      people: [],
      unknownFaces: 0,
      faceScannedAt: 0,
    });
  }

  // 4. Membership + keys off the account.
  await accounts.updateAccount(target.id, (cur) => ({
    ...cur,
    familyId: null,
    encFk: null,
    updatedAt: Date.now(),
  }));
  keyring.setFamily(target.id, null);

  // 5. Rotate: new FK, re-encrypt everything in the scope, re-seal to the rest.
  const newFk = randomKey();
  await people.reencryptScope(family.id, oldFk, newFk);
  await relationships.reencryptScope(family.id, oldFk, newFk);
  if (process.env.INFERENCE_DISABLED !== '1') {
    const face = await import('../face.ts').catch(() => null);
    if (face) await face.reencryptScopeCaches(family.id, oldFk, newFk);
  }
  for (const member of await accounts.listAccounts(family.id)) {
    if (!member.pubKey) continue;
    await accounts.updateAccount(member.id, (cur) => ({
      ...cur,
      encFk: sealToPub(Buffer.from(cur.pubKey!, 'base64url'), newFk),
      updatedAt: Date.now(),
    }));
  }
  // Pending invites carry the old key — void them; the owner can re-invite.
  for (const invite of await families.listInvitesForFamily(family.id)) {
    await families.deleteInvite(invite.id);
  }
  keyring.putFamilyKey(family.id, newFk);
  console.log(`[family] ${target.username} left ${family.id}; family key rotated`);
}

familyRoutes.post('/me/family/leave', async (c) => {
  const account = c.get('account');
  if (account.accountType !== 'personal' || !account.familyId)
    return err(c, 'VALIDATION', 'not a family member');
  const family = await families.getFamily(account.familyId);
  if (!family) return err(c, 'NOT_FOUND', 'family not found');
  const fk = keyring.getFamilyKey(family.id);
  if (!fk) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  await removeMember(family, account, fk);
  const updated = await accounts.getAccount(account.id);
  return c.json({ ok: true, user: updated ? accounts.toPublic(updated) : accounts.toPublic(account) });
});

familyRoutes.delete('/family/members/:id', async (c) => {
  const account = c.get('account');
  if (!isFamilyOwner(account)) return err(c, 'FORBIDDEN', 'family owner required');
  const family = await families.getFamily(account.familyId!);
  if (!family) return err(c, 'NOT_FOUND', 'family not found');
  const target = await accounts.getAccount(c.req.param('id'));
  if (!target || target.familyId !== family.id) return err(c, 'NOT_FOUND', 'member not found');
  if (target.id === account.id) return err(c, 'VALIDATION', 'owner cannot remove themselves');
  const fk = keyring.getFamilyKey(family.id);
  if (!fk) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  await removeMember(family, target, fk);
  return c.json({ ok: true });
});

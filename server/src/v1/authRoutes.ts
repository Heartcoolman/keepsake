/** Auth + account lifecycle. Two account types: 'family' (owns a family, invites
 *  members, future paid plan) and 'personal' (free; standalone or family member).
 *  Every flow that sees the password installs the account's keys into the
 *  in-memory keyring — that is what makes the encrypted at-rest data readable
 *  for the session. No admin password reset exists: recovery codes only. */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as people from '../people.ts';
import * as store from '../store.ts';
import * as keyring from '../keyring.ts';
import { isMigrationPending } from '../deferredTasks.ts';
import { getRegistrationPolicy } from '../ops/opsConfig.ts';
import { normalizeRecoveryCode, openSealed, randomKey, sealToPub } from '../crypto.ts';
import { err } from './errors.ts';
import { forwardedHeader, ipRateLimit, requireAuth, type AppEnv } from './middleware.ts';

export const authRoutes = new Hono<AppEnv>();

/** Web clients keep the long-lived refresh token in an httpOnly cookie so an
 *  XSS cannot exfiltrate it; the JSON body still carries it for native apps. */
const REFRESH_COOKIE = 'nx_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function isSecureRequest(c: Context): boolean {
  const proto = forwardedHeader(c, 'x-forwarded-proto');
  if (proto) return proto === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Constant-time string compare so a mismatch's timing can't leak a secret's prefix. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function setRefreshCookie(c: Context, refreshToken: string): void {
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isSecureRequest(c),
    path: REFRESH_COOKIE_PATH,
    maxAge: accounts.REFRESH_TTL_SECONDS,
  });
}

function clearRefreshCookie(c: Context): void {
  deleteCookie(c, REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

function statusError(c: Context, e: unknown) {
  const status = Number((e as { status?: unknown }).status);
  if (status === 400) return err(c, 'VALIDATION', (e as Error).message);
  if (status === 409) return err(c, 'CONFLICT', (e as Error).message);
  throw e;
}

/** Ensure an isUser Person exists for this account inside its current scope. */
async function ensureUserPerson(
  account: accounts.Account,
  scopeId: string,
  scopeKey: Buffer,
): Promise<void> {
  const existing = await people.getPersonScope(account.id);
  if (existing) return;
  const now = Date.now();
  await people.putPerson(
    {
      id: account.id,
      scopeId,
      name: account.displayName,
      relation: '本人',
      relations: {},
      isUser: true,
      createdAt: now,
      updatedAt: now,
      templates: [],
      enrolledFrom: [],
    },
    scopeKey,
  );
}

/** One family key may be created per (pre-migration) family — serialize per family. */
const fkCreation = new Map<string, Promise<Buffer | undefined>>();

/** Resolve this account's family key at login/unlock time:
 *  1. sealed grant on the account, 2. live keyring (another member online),
 *  3. first-ever holder of a migrated family creates it. */
async function resolveFamilyKey(
  account: accounts.Account,
  keys: { udk: Buffer; priv: Buffer; pub: Buffer },
): Promise<Buffer | undefined> {
  const familyId = account.familyId;
  if (!familyId) return undefined;
  if (account.encFk) {
    try {
      return openSealed(account.encFk, keys.priv, keys.pub);
    } catch (e) {
      console.warn('[auth] family key grant unreadable for', account.username, e);
    }
  }
  const live = keyring.getFamilyKey(familyId);
  if (live) {
    await accounts.updateAccount(account.id, (cur) => ({
      ...cur,
      encFk: sealToPub(keys.pub, live),
      updatedAt: Date.now(),
    }));
    return live;
  }
  let creation = fkCreation.get(familyId);
  if (!creation) {
    creation = (async () => {
      const members = await accounts.listAccounts(familyId);
      if (members.some((m) => m.encFk)) return undefined; // FK exists, we just can't open it
      const fk = randomKey();
      await accounts.updateAccount(account.id, (cur) => ({
        ...cur,
        encFk: sealToPub(keys.pub, fk),
        updatedAt: Date.now(),
      }));
      console.log(`[auth] family key created for migrated family ${familyId}`);
      return fk;
    })();
    fkCreation.set(familyId, creation);
    void creation.finally(() => fkCreation.delete(familyId));
  }
  return creation;
}

/** Install keys into the keyring and fire the deferred catchup. */
function installKeys(
  account: accounts.Account,
  keys: { udk: Buffer; priv: Buffer },
  fk: Buffer | undefined,
): void {
  keyring.putAccountKeys(account.id, account.familyId, keys.udk, keys.priv);
  if (fk && account.familyId) keyring.putFamilyKey(account.familyId, fk);
  keyring.notifyUnlock({
    accountId: account.id,
    familyId: account.familyId,
    scopeId: accounts.scopeIdOf(account),
    udk: keys.udk,
    priv: keys.priv,
    fk,
  });
}

interface RegisterOutcome {
  account: accounts.Account;
  recoveryCode: string;
}

/** Shared by /auth/register (family type) and /auth/bootstrap. */
async function registerFamilyAccount(input: {
  username: string;
  password: string;
  displayName?: string;
  familyName?: string;
  preferredId?: string;
  first: boolean;
}): Promise<RegisterOutcome> {
  const create = input.first ? accounts.createFirstAccount : accounts.createAccount;
  const created = await create({
    id: input.preferredId,
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    role: 'admin',
    accountType: 'family',
  });
  const family = await families.createFamily(
    input.familyName?.trim() || `${created.account.displayName}的家庭`,
    created.account.id,
  );
  const fk = randomKey();
  const updated = await accounts.updateAccount(created.account.id, (cur) => ({
    ...cur,
    familyId: family.id,
    encFk: sealToPub(created.pub, fk),
    updatedAt: Date.now(),
  }));
  const account = updated ?? created.account;
  await ensureUserPerson(account, family.id, fk);
  installKeys(account, created, fk);
  return { account, recoveryCode: created.recoveryCode };
}

async function registerPersonalAccount(input: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<RegisterOutcome> {
  const created = await accounts.createAccount({
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    role: 'member',
    accountType: 'personal',
  });
  await ensureUserPerson(created.account, created.account.id, created.udk);
  installKeys(created.account, created, undefined);
  return { account: created.account, recoveryCode: created.recoveryCode };
}

// ---------- registration ----------

authRoutes.post('/auth/register', ipRateLimit(10), async (c) => {
  const body = await c.req.json<{
    accountType?: unknown;
    username?: unknown;
    password?: unknown;
    displayName?: unknown;
    familyName?: unknown;
    regCode?: unknown;
  }>().catch(() => ({} as Record<string, unknown>));

  // Registration policy: the ops-managed config file wins outright once it
  // exists; the REGISTRATION_CODE env var only applies before that.
  const policy = await getRegistrationPolicy();
  if (!policy.open) return err(c, 'FORBIDDEN', 'registration is closed');
  if (policy.code) {
    const header = c.req.header('x-registration-code') ?? '';
    const fromBody = typeof body.regCode === 'string' ? body.regCode : '';
    if (!safeEqual(header || fromBody, policy.code))
      return err(c, 'UNAUTHORIZED', 'invalid registration code');
  }

  const accountType = body.accountType === 'family' ? 'family' : body.accountType === 'personal' ? 'personal' : null;
  if (!accountType) return err(c, 'VALIDATION', 'accountType must be family or personal');
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : username;

  try {
    const outcome =
      accountType === 'family'
        ? await registerFamilyAccount({
            username,
            password,
            displayName,
            familyName: typeof body.familyName === 'string' ? body.familyName : undefined,
            first: false,
          })
        : await registerPersonalAccount({ username, password, displayName });
    const tokens = await accounts.issueTokens(outcome.account);
    setRefreshCookie(c, tokens.refreshToken);
    return c.json(
      { ...tokens, user: accounts.toPublic(outcome.account), recoveryCode: outcome.recoveryCode },
      201,
    );
  } catch (e) {
    return statusError(c, e);
  }
});

/** Compat alias: first family on a fresh server (mobile clients call this). */
authRoutes.post('/auth/bootstrap', ipRateLimit(10), async (c) => {
  const body = await c.req.json<{
    username?: unknown;
    password?: unknown;
    displayName?: unknown;
    familyName?: unknown;
    bootstrapToken?: unknown;
  }>().catch(() => ({} as Record<string, unknown>));

  // Optional setup token: when BOOTSTRAP_TOKEN is set, require matching header/body.
  const expected = process.env.BOOTSTRAP_TOKEN?.trim();
  if (expected) {
    const header = c.req.header('x-bootstrap-token') ?? '';
    const fromBody = typeof body.bootstrapToken === 'string' ? body.bootstrapToken : '';
    if (!safeEqual(header || fromBody, expected))
      return err(c, 'UNAUTHORIZED', 'invalid bootstrap token');
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : username;

  // Prefer reusing the sole isUser person id so existing memory bank + entries keep working
  const userPeople = (await people.listScopes()).filter((p) => p.isUser);
  const preferredId = userPeople.length === 1 ? userPeople[0]!.id : undefined;
  let preferredName = displayName;
  if (!preferredName && preferredId) {
    // legacy person rows are still plaintext pre-migration — readable without a key
    preferredName = (await people.getPerson(preferredId, undefined).catch(() => undefined))?.name ?? username;
  }

  let outcome: RegisterOutcome;
  try {
    outcome = await registerFamilyAccount({
      username,
      password,
      displayName: preferredName || username,
      familyName: typeof body.familyName === 'string' ? body.familyName : undefined,
      preferredId,
      first: true,
    });
  } catch (e) {
    return statusError(c, e);
  }
  const account = outcome.account;

  // Claim unowned / matching legacy entries into the new owner + family scope
  let claimed = 0;
  for (const entry of await store.listEntries()) {
    const cur = entry.ownerId || entry.userId;
    if (cur && cur !== account.id) continue;
    const updated = await store.patchEntry(entry.id, {
      ownerId: account.id,
      userId: account.id,
      familyId: account.familyId,
    });
    if (updated) claimed++;
  }
  if (claimed) console.log(`[auth] bootstrap claimed ${claimed} entries for ${account.id}`);

  // Pre-auth legacy people/relationships have no scope yet — adopt them.
  if (account.familyId) {
    for (const p of await people.listScopes()) {
      if (!p.scopeId) await people.assignScope(p.id, account.familyId);
    }
  }

  const tokens = await accounts.issueTokens(account);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    ...tokens,
    user: accounts.toPublic(account),
    recoveryCode: outcome.recoveryCode,
  });
});

// ---------- session ----------

authRoutes.post('/auth/login', ipRateLimit(20), async (c) => {
  const body = await c.req.json<{ username?: unknown; password?: unknown }>();
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return err(c, 'VALIDATION', 'username and password required');
  let account = await accounts.findByUsername(username);
  // Always run one scrypt verify — against a dummy hash when the account is
  // missing/disabled — so login latency can't be used to enumerate usernames.
  const stored =
    account && !account.disabled ? account.passwordHash : await accounts.dummyPasswordHash();
  const passwordOk = await accounts.verifyPassword(password, stored);
  if (!account || account.disabled || !passwordOk)
    return err(c, 'UNAUTHORIZED', 'invalid credentials');

  // Legacy account's first login after the upgrade: provision crypto in place.
  let freshRecoveryCode: string | undefined;
  if (!accounts.hasCrypto(account)) {
    const provisioned = await accounts.provisionCrypto(password);
    account = (await accounts.updateAccount(account.id, (cur) => ({
      ...cur,
      ...provisioned.fields,
      updatedAt: Date.now(),
    }))) ?? account;
    freshRecoveryCode = provisioned.recoveryCode;
    console.log(`[auth] provisioned at-rest keys for ${account.username}`);
  }

  const keys = await accounts.unlockKeys(account, password);
  if (keys) {
    const fk = await resolveFamilyKey(account, keys);
    account = (await accounts.getAccount(account.id)) ?? account;
    if (account.familyId && fk) await ensureUserPerson(account, account.familyId, fk);
    else if (!account.familyId) await ensureUserPerson(account, account.id, keys.udk);
    installKeys(account, keys, fk);
  }

  const tokens = await accounts.issueTokens(account);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    ...tokens,
    user: accounts.toPublic(account),
    ...(freshRecoveryCode ? { recoveryCode: freshRecoveryCode } : {}),
  });
});

/** Valid JWT but empty keyring (server restart): re-enter the password. */
authRoutes.post('/auth/unlock', requireAuth, ipRateLimit(20), async (c) => {
  let account = c.get('account');
  const body = await c.req.json<{ password?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return err(c, 'VALIDATION', 'password required');
  if (!(await accounts.verifyPassword(password, account.passwordHash)))
    return err(c, 'UNAUTHORIZED', 'invalid credentials');

  let freshRecoveryCode: string | undefined;
  if (!accounts.hasCrypto(account)) {
    const provisioned = await accounts.provisionCrypto(password);
    account = (await accounts.updateAccount(account.id, (cur) => ({
      ...cur,
      ...provisioned.fields,
      updatedAt: Date.now(),
    }))) ?? account;
    freshRecoveryCode = provisioned.recoveryCode;
  }
  const keys = await accounts.unlockKeys(account, password);
  if (!keys) return err(c, 'INTERNAL', 'key material unreadable');
  const fk = await resolveFamilyKey(account, keys);
  account = (await accounts.getAccount(account.id)) ?? account;
  installKeys(account, keys, fk);
  return c.json({ ok: true, ...(freshRecoveryCode ? { recoveryCode: freshRecoveryCode } : {}) });
});

authRoutes.post('/auth/refresh', ipRateLimit(30), async (c) => {
  const body = await c.req.json<{ refreshToken?: unknown }>().catch(() => ({}));
  const fromBody =
    typeof (body as { refreshToken?: unknown }).refreshToken === 'string'
      ? (body as { refreshToken: string }).refreshToken
      : '';
  // Native clients send the token in the body; web clients rely on the cookie.
  const token = fromBody || getCookie(c, REFRESH_COOKIE) || '';
  if (!token) return err(c, 'VALIDATION', 'refreshToken required');
  const rotated = await accounts.rotateRefreshToken(token);
  if (!rotated) {
    clearRefreshCookie(c);
    return err(c, 'UNAUTHORIZED', 'invalid refresh token');
  }
  setRefreshCookie(c, rotated.tokens.refreshToken);
  return c.json({ ...rotated.tokens, user: accounts.toPublic(rotated.account) });
});

authRoutes.post('/auth/logout', requireAuth, async (c) => {
  const account = c.get('account');
  // Deliberately bumps tokenVersion: logout revokes every outstanding token
  // for this account (all devices). Clearing only refreshJti would reopen the
  // legacy "accept any refresh with matching tv" path — see resolveRefreshToken.
  await accounts.bumpTokenVersion(account.id);
  keyring.wipe(account.id);
  clearRefreshCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', requireAuth, async (c) => {
  const account = c.get('account');
  const family = account.familyId ? await families.getFamily(account.familyId) : undefined;
  return c.json({
    user: accounts.toPublic(account),
    family: family ? { id: family.id, name: family.name, ownerId: family.ownerId } : null,
    migrationPending: await isMigrationPending(account.id),
    locked: !keyring.getUdk(account.id),
  });
});

authRoutes.patch('/auth/me/password', requireAuth, async (c) => {
  const account = c.get('account');
  const body = await c.req.json<{ currentPassword?: unknown; newPassword?: unknown }>();
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!(await accounts.verifyPassword(current, account.passwordHash)))
    return err(c, 'UNAUTHORIZED', 'current password incorrect');
  if (!accounts.validPassword(next)) return err(c, 'VALIDATION', 'password too short');
  const keys = await accounts.unlockKeys(account, current);
  const nextHash = await accounts.hashPassword(next);
  const wraps = keys ? await accounts.makePasswordWraps(next, keys.udk, keys.priv) : null;
  const updated = await accounts.updateAccount(account.id, (currentAccount) => ({
    ...currentAccount,
    passwordHash: nextHash,
    ...(wraps ?? {}),
    tokenVersion: currentAccount.tokenVersion + 1,
    refreshJti: null,
    updatedAt: Date.now(),
  }));
  if (!updated) return err(c, 'NOT_FOUND', 'user not found');
  if (keys) {
    const fk = await resolveFamilyKey(updated, keys);
    installKeys(updated, keys, fk);
  }
  const tokens = await accounts.issueTokens(updated);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({ ...tokens, user: accounts.toPublic(updated) });
});

// ---------- recovery ----------

authRoutes.post('/auth/recover', ipRateLimit(10), async (c) => {
  const body = await c.req.json<{
    username?: unknown;
    recoveryCode?: unknown;
    newPassword?: unknown;
  }>().catch(() => ({} as Record<string, unknown>));
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const code = typeof body.recoveryCode === 'string' ? normalizeRecoveryCode(body.recoveryCode) : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!username || !code) return err(c, 'VALIDATION', 'username and recoveryCode required');
  if (!accounts.validPassword(newPassword)) return err(c, 'VALIDATION', 'password too short');

  const account = await accounts.findByUsername(username);
  const keys = account && !account.disabled ? await accounts.unlockKeysWithRecovery(account, code) : null;
  if (!account || !keys) return err(c, 'UNAUTHORIZED', 'invalid recovery code');

  const wraps = await accounts.makePasswordWraps(newPassword, keys.udk, keys.priv);
  const recovery = await accounts.makeRecoveryFields(keys.udk, keys.priv);
  const nextHash = await accounts.hashPassword(newPassword);
  const updated = await accounts.updateAccount(account.id, (cur) => ({
    ...cur,
    passwordHash: nextHash,
    ...wraps,
    ...recovery.fields,
    tokenVersion: cur.tokenVersion + 1,
    refreshJti: null,
    updatedAt: Date.now(),
  }));
  if (!updated) return err(c, 'NOT_FOUND', 'user not found');

  const fk = await resolveFamilyKey(updated, keys);
  installKeys(updated, keys, fk);
  const tokens = await accounts.issueTokens(updated);
  setRefreshCookie(c, tokens.refreshToken);
  return c.json({
    ...tokens,
    user: accounts.toPublic(updated),
    recoveryCode: recovery.recoveryCode,
  });
});

/** Rotate + reveal a fresh recovery code (requires the password again). */
authRoutes.post('/auth/me/recovery-code', requireAuth, ipRateLimit(10), async (c) => {
  const account = c.get('account');
  const body = await c.req.json<{ currentPassword?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!(await accounts.verifyPassword(current, account.passwordHash)))
    return err(c, 'UNAUTHORIZED', 'current password incorrect');
  const keys = await accounts.unlockKeys(account, current);
  if (!keys) return err(c, 'INTERNAL', 'key material unreadable');
  const recovery = await accounts.makeRecoveryFields(keys.udk, keys.priv);
  await accounts.updateAccount(account.id, (cur) => ({
    ...cur,
    ...recovery.fields,
    updatedAt: Date.now(),
  }));
  return c.json({ recoveryCode: recovery.recoveryCode });
});

// ---------- member listing (family-scoped; account CRUD moved to invites) ----------

authRoutes.get('/users', requireAuth, async (c) => {
  const account = c.get('account');
  const list = account.familyId
    ? (await accounts.listAccounts(account.familyId)).map(accounts.toPublic)
    : [accounts.toPublic(account)];
  return c.json({ items: list });
});

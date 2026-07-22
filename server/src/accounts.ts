/** Auth accounts: data/accounts/<id>.json — separate from memory bank at data/users/.
 *  Besides login credentials each account carries its at-rest key material:
 *  KEK = scrypt(password, kekSalt) wraps the UDK (personal data key) and the X25519
 *  private key; the family key arrives sealed to the public key (encFk). Recovery
 *  wraps duplicate UDK/priv under a KDF of the one-shot recovery code. */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { signHS256, verifyHS256 } from './lib/jwt.ts';
import {
  deriveKek,
  generateRecoveryCode,
  generateX25519KeyPair,
  isEnvelope,
  isSealedBox,
  randomKey,
  unwrapKey,
  wrapKey,
  type Envelope,
  type SealedBox,
} from './crypto.ts';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export type AccountRole = 'admin' | 'member';
export type AccountType = 'family' | 'personal';

export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role: AccountRole;
  /** family accounts own a family and can invite; personal accounts join/leave */
  accountType: AccountType;
  /** billing reservation — no enforcement yet */
  plan: string;
  familyId: string | null;
  tokenVersion: number;
  /** Current refresh jti; null = accept any refresh with matching tv (legacy). */
  refreshJti: string | null;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  // ---- at-rest crypto (null until provisioned; legacy accounts provision on first login)
  kekSalt: string | null;
  encUdk: Envelope | null;
  pubKey: string | null;
  encPrivKey: Envelope | null;
  encFk: SealedBox | null;
  recoverySalt: string | null;
  encUdkRecovery: Envelope | null;
  encPrivKeyRecovery: Envelope | null;
  /** isUser person bundle sealed to pubKey after a removal-while-offline; converted
   *  back into the personal scope on next login. */
  pendingPerson: SealedBox | null;
}

export interface AccountPublic {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  accountType: AccountType;
  plan: string;
  familyId: string | null;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The scope this account's shared data (people/graph/faces) lives in. */
export function scopeIdOf(account: Account): string {
  return account.familyId ?? account.id;
}

/** Destructive scope operations: family owner, or a standalone account over itself. */
export function isScopeOwner(account: Account): boolean {
  return account.familyId === null || account.accountType === 'family';
}

export function hasCrypto(account: Account): boolean {
  return !!(account.kekSalt && account.encUdk && account.pubKey && account.encPrivKey);
}

const DIR = fileURLToPath(new URL('../data/accounts/', import.meta.url));
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD = 8;

let index: Map<string, Account> | null = null;
let indexLoad: Promise<Map<string, Account>> | null = null;
const enqueue = createKeyedQueue();
let accountMutationTail: Promise<void> = Promise.resolve();

/** Serialize operations whose invariants span the whole account collection. */
function enqueueAccountMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = accountMutationTail.then(task, task);
  accountMutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function toPublic(a: Account): AccountPublic {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    accountType: a.accountType,
    plan: a.plan,
    familyId: a.familyId,
    disabled: a.disabled,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function validUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

export function validPassword(p: string): boolean {
  return typeof p === 'string' && p.length >= MIN_PASSWORD && p.length <= 128;
}

/** scrypt salt:hash, both base64url — async so hashing never blocks the event loop */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await scryptAsync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Scrypt hash of an unguessable value, verified against on login misses so an
 *  unknown/disabled username costs the same scrypt time as a wrong password —
 *  otherwise response latency leaks whether a username exists. */
let dummyHashPromise: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomUUID() + randomUUID());
  return dummyHashPromise;
}

const envOrNull = (v: unknown): Envelope | null => (isEnvelope(v) ? v : null);
const sealedOrNull = (v: unknown): SealedBox | null => (isSealedBox(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function normalizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
  if (typeof v.username !== 'string' || !validUsername(v.username)) return null;
  if (typeof v.passwordHash !== 'string' || !v.passwordHash.includes(':')) return null;
  const role = v.role === 'admin' ? 'admin' : 'member';
  return {
    id: v.id,
    username: v.username,
    passwordHash: v.passwordHash,
    displayName:
      typeof v.displayName === 'string' && v.displayName.trim()
        ? v.displayName.trim().slice(0, 40)
        : v.username,
    role,
    // legacy rows predate accountType — the family migration sets it explicitly
    accountType: v.accountType === 'family' ? 'family' : 'personal',
    plan: typeof v.plan === 'string' && v.plan ? v.plan.slice(0, 32) : 'free',
    familyId: typeof v.familyId === 'string' && ID_RE.test(v.familyId) ? v.familyId : null,
    tokenVersion: Math.max(0, Math.floor(Number(v.tokenVersion) || 0)),
    refreshJti: typeof v.refreshJti === 'string' && v.refreshJti ? v.refreshJti : null,
    disabled: v.disabled === true,
    createdAt: Number.isFinite(Number(v.createdAt)) ? Number(v.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : Date.now(),
    kekSalt: strOrNull(v.kekSalt),
    encUdk: envOrNull(v.encUdk),
    pubKey: strOrNull(v.pubKey),
    encPrivKey: envOrNull(v.encPrivKey),
    encFk: sealedOrNull(v.encFk),
    recoverySalt: strOrNull(v.recoverySalt),
    encUdkRecovery: envOrNull(v.encUdkRecovery),
    encPrivKeyRecovery: envOrNull(v.encPrivKeyRecovery),
    pendingPerson: sealedOrNull(v.pendingPerson),
  };
}

async function load(): Promise<Map<string, Account>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, Account>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const a = normalizeAccount(JSON.parse(await readFile(DIR + f, 'utf8')));
          if (!a || a.id !== f.slice(0, -'.json'.length)) continue;
          map.set(a.id, a);
        } catch {
          console.warn('[accounts] skipping corrupt', f);
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

export async function countAccounts(): Promise<number> {
  return (await load()).size;
}

export async function listAccounts(familyId?: string): Promise<Account[]> {
  const all = [...(await load()).values()].sort((a, b) => a.createdAt - b.createdAt);
  return familyId ? all.filter((a) => a.familyId === familyId) : all;
}

export async function getAccount(id: string): Promise<Account | undefined> {
  return (await load()).get(id);
}

export async function findByUsername(username: string): Promise<Account | undefined> {
  const u = username.trim();
  return (await listAccounts()).find((a) => a.username.toLowerCase() === u.toLowerCase());
}

export async function putAccount(account: Account): Promise<Account> {
  const safe = normalizeAccount(account);
  if (!safe) throw new Error('invalid account');
  return enqueue(safe.id, async () => {
    const map = await load();
    await mkdir(DIR, { recursive: true });
    await writeAtomic(DIR + safe.id + '.json', JSON.stringify(safe));
    map.set(safe.id, safe);
    return safe;
  });
}

// ---------- crypto provisioning ----------

export interface CryptoFields {
  kekSalt: string;
  encUdk: Envelope;
  pubKey: string;
  encPrivKey: Envelope;
  recoverySalt: string;
  encUdkRecovery: Envelope;
  encPrivKeyRecovery: Envelope;
}

export interface ProvisionedKeys {
  fields: CryptoFields;
  udk: Buffer;
  priv: Buffer;
  pub: Buffer;
  recoveryCode: string;
}

/** Fresh UDK + X25519 keypair, wrapped for the password and a one-shot recovery code. */
export async function provisionCrypto(
  password: string,
  existing?: { udk: Buffer; priv: Buffer; pub: Buffer },
): Promise<ProvisionedKeys> {
  const kekSalt = randomBytes(16);
  const kek = await deriveKek(password, kekSalt);
  const udk = existing?.udk ?? randomKey();
  const { pub, priv } = existing ?? generateX25519KeyPair();
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = randomBytes(16);
  const rk = await deriveKek(recoveryCode.replaceAll('-', ''), recoverySalt);
  return {
    fields: {
      kekSalt: kekSalt.toString('base64url'),
      encUdk: wrapKey(udk, kek),
      pubKey: pub.toString('base64url'),
      encPrivKey: wrapKey(priv, kek),
      recoverySalt: recoverySalt.toString('base64url'),
      encUdkRecovery: wrapKey(udk, rk),
      encPrivKeyRecovery: wrapKey(priv, rk),
    },
    udk,
    priv,
    pub,
    recoveryCode,
  };
}

/** Re-wrap existing keys under a new password (self password change). */
export async function makePasswordWraps(
  password: string,
  udk: Buffer,
  priv: Buffer,
): Promise<Pick<CryptoFields, 'kekSalt' | 'encUdk' | 'encPrivKey'>> {
  const kekSalt = randomBytes(16);
  const kek = await deriveKek(password, kekSalt);
  return {
    kekSalt: kekSalt.toString('base64url'),
    encUdk: wrapKey(udk, kek),
    encPrivKey: wrapKey(priv, kek),
  };
}

/** Rotate the recovery code: new code + new wraps of the same keys. */
export async function makeRecoveryFields(
  udk: Buffer,
  priv: Buffer,
): Promise<{
  fields: Pick<CryptoFields, 'recoverySalt' | 'encUdkRecovery' | 'encPrivKeyRecovery'>;
  recoveryCode: string;
}> {
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = randomBytes(16);
  const rk = await deriveKek(recoveryCode.replaceAll('-', ''), recoverySalt);
  return {
    fields: {
      recoverySalt: recoverySalt.toString('base64url'),
      encUdkRecovery: wrapKey(udk, rk),
      encPrivKeyRecovery: wrapKey(priv, rk),
    },
    recoveryCode,
  };
}

/** Unwrap UDK + private key with the account password. Null on wrong password/no crypto. */
export async function unlockKeys(
  account: Account,
  password: string,
): Promise<{ udk: Buffer; priv: Buffer; pub: Buffer } | null> {
  if (!hasCrypto(account)) return null;
  try {
    const kek = await deriveKek(password, Buffer.from(account.kekSalt!, 'base64url'));
    return {
      udk: unwrapKey(account.encUdk!, kek),
      priv: unwrapKey(account.encPrivKey!, kek),
      pub: Buffer.from(account.pubKey!, 'base64url'),
    };
  } catch {
    return null;
  }
}

/** Unwrap with a recovery code instead of the password. */
export async function unlockKeysWithRecovery(
  account: Account,
  recoveryCode: string,
): Promise<{ udk: Buffer; priv: Buffer; pub: Buffer } | null> {
  if (!account.recoverySalt || !account.encUdkRecovery || !account.encPrivKeyRecovery || !account.pubKey)
    return null;
  try {
    const rk = await deriveKek(recoveryCode, Buffer.from(account.recoverySalt, 'base64url'));
    return {
      udk: unwrapKey(account.encUdkRecovery, rk),
      priv: unwrapKey(account.encPrivKeyRecovery, rk),
      pub: Buffer.from(account.pubKey, 'base64url'),
    };
  } catch {
    return null;
  }
}

type CreateAccountInput = {
  id?: string;
  username: string;
  password: string;
  displayName?: string;
  role: AccountRole;
  accountType: AccountType;
  familyId?: string | null;
};

export interface CreateAccountResult {
  account: Account;
  udk: Buffer;
  priv: Buffer;
  pub: Buffer;
  recoveryCode: string;
}

async function createAccountUnlocked(
  input: CreateAccountInput,
  requireEmpty: boolean,
): Promise<CreateAccountResult> {
  if (!validUsername(input.username)) throw Object.assign(new Error('invalid username'), { status: 400 });
  if (!validPassword(input.password)) throw Object.assign(new Error('password too short'), { status: 400 });
  if (requireEmpty && (await countAccounts()) > 0)
    throw Object.assign(new Error('already bootstrapped'), { status: 409 });
  const existing = await findByUsername(input.username);
  if (existing) throw Object.assign(new Error('username taken'), { status: 409 });
  const now = Date.now();
  const provisioned = await provisionCrypto(input.password);
  const account: Account = {
    id: input.id && ID_RE.test(input.id) ? input.id : randomUUID(),
    username: input.username,
    passwordHash: await hashPassword(input.password),
    displayName: (input.displayName?.trim() || input.username).slice(0, 40),
    role: input.role,
    accountType: input.accountType,
    plan: 'free',
    familyId: input.familyId ?? null,
    tokenVersion: 0,
    refreshJti: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    ...provisioned.fields,
    encFk: null,
    pendingPerson: null,
  };
  // ensure id not taken
  if (await getAccount(account.id)) throw Object.assign(new Error('id taken'), { status: 409 });
  const saved = await putAccount(account);
  return {
    account: saved,
    udk: provisioned.udk,
    priv: provisioned.priv,
    pub: provisioned.pub,
    recoveryCode: provisioned.recoveryCode,
  };
}

export function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  return enqueueAccountMutation(() => createAccountUnlocked(input, false));
}

export function createFirstAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  return enqueueAccountMutation(() => createAccountUnlocked(input, true));
}

export function updateAccount(
  id: string,
  update: (current: Account, all: Account[]) => Account,
): Promise<Account | undefined> {
  return enqueueAccountMutation(async () => {
    const current = await getAccount(id);
    if (!current) return undefined;
    const next = update(current, await listAccounts());
    return putAccount(next);
  });
}

/** Ops purge: remove the account record itself (data cleanup is the caller's). */
export function deleteAccount(id: string): Promise<boolean> {
  return enqueueAccountMutation(() =>
    enqueue(id, async () => {
      const map = await load();
      if (!map.has(id)) return false;
      await rm(DIR + id + '.json', { force: true });
      map.delete(id);
      return true;
    }),
  );
}

// ---------- JWT (HS256) ----------

export interface TokenClaims {
  sub: string;
  role: AccountRole;
  tv: number; // tokenVersion
  typ: 'access' | 'refresh';
  exp: number;
  iat: number;
  /** Refresh-token id; rotated on each refresh. */
  jti?: string;
}

/** User-token signing secret; the ops console derives its own domain-separated
 *  key from this (see ops/opsAccounts.ts), never signing in the same domain. */
export function getJwtSecret(): string {
  const s = process.env.JWT_SECRET?.trim();
  if (s && s.length >= 16) return s;
  if (process.env.ALLOW_EPHEMERAL_JWT !== '1')
    throw new Error('JWT_SECRET must be at least 16 characters (or set ALLOW_EPHEMERAL_JWT=1 for local development)');
  if (!getJwtSecret.warned) {
    console.warn('[auth] using an ephemeral JWT secret; tokens will invalidate on restart');
    getJwtSecret.warned = true;
  }
  if (!getJwtSecret.ephemeral) getJwtSecret.ephemeral = randomBytes(32).toString('hex');
  return getJwtSecret.ephemeral;
}
getJwtSecret.warned = false;
getJwtSecret.ephemeral = '' as string;

export function assertAuthConfigured(): void {
  void getJwtSecret();
}

function sign(payload: object): string {
  return signHS256(payload, getJwtSecret());
}

export function verifyToken(token: string): TokenClaims | null {
  const claims = verifyHS256(token, getJwtSecret());
  if (!claims) return null;
  if (claims.typ !== 'access' && claims.typ !== 'refresh') return null;
  return claims as unknown as TokenClaims;
}

const ACCESS_TTL = 60 * 60; // 1h
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30d
/** Exposed for the refresh-token cookie max-age. */
export const REFRESH_TTL_SECONDS = REFRESH_TTL;

function mintPair(account: Account, refreshJti: string): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} {
  const iat = Math.floor(Date.now() / 1000);
  const accessToken = sign({
    sub: account.id,
    role: account.role,
    tv: account.tokenVersion,
    typ: 'access',
    iat,
    exp: iat + ACCESS_TTL,
  } satisfies TokenClaims);
  const refreshToken = sign({
    sub: account.id,
    role: account.role,
    tv: account.tokenVersion,
    typ: 'refresh',
    jti: refreshJti,
    iat,
    exp: iat + REFRESH_TTL,
  } satisfies TokenClaims);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL };
}

/** Issue tokens and persist a new refresh jti (rotates any prior refresh). */
export async function issueTokens(account: Account): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const jti = randomUUID();
  const updated = await updateAccount(account.id, (cur) => ({
    ...cur,
    refreshJti: jti,
    updatedAt: Date.now(),
  }));
  const base = updated ?? { ...account, refreshJti: jti };
  return mintPair(base, jti);
}

export async function resolveAccessToken(token: string): Promise<Account | null> {
  const claims = verifyToken(token);
  if (!claims || claims.typ !== 'access') return null;
  const account = await getAccount(claims.sub);
  if (!account || account.disabled) return null;
  if (claims.tv !== account.tokenVersion) return null;
  return account;
}

export async function resolveRefreshToken(token: string): Promise<Account | null> {
  const claims = verifyToken(token);
  if (!claims || claims.typ !== 'refresh') return null;
  const account = await getAccount(claims.sub);
  if (!account || account.disabled) return null;
  if (claims.tv !== account.tokenVersion) return null;
  // After first rotation, refreshJti is set; require matching jti.
  // Legacy tokens (no jti / null refreshJti) accepted once, then rotated on issueTokens.
  if (account.refreshJti) {
    if (!claims.jti || claims.jti !== account.refreshJti) return null;
  }
  return account;
}

/** Rotate refresh: validate old token, mint new jti, invalidate previous. */
export async function rotateRefreshToken(token: string): Promise<{
  account: Account;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
} | null> {
  const claims = verifyToken(token);
  if (!claims || claims.typ !== 'refresh') return null;
  return enqueueAccountMutation(async () => {
    const account = await getAccount(claims.sub);
    if (!account || account.disabled) return null;
    if (claims.tv !== account.tokenVersion) return null;
    if (account.refreshJti) {
      if (!claims.jti || claims.jti !== account.refreshJti) return null;
    }
    const jti = randomUUID();
    const next: Account = {
      ...account,
      refreshJti: jti,
      updatedAt: Date.now(),
    };
    await putAccount(next);
    return { account: next, tokens: mintPair(next, jti) };
  });
}

export async function bumpTokenVersion(id: string): Promise<Account | undefined> {
  return updateAccount(id, (cur) => ({
    ...cur,
    tokenVersion: cur.tokenVersion + 1,
    refreshJti: null,
    updatedAt: Date.now(),
  }));
}

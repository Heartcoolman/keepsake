/** Operator accounts for the /ops console: data/ops/<id>.json.
 *  Operators hold no user-data key material and can never decrypt user content.
 *  Their tokens sign in a separate HKDF-derived domain, so user tokens and ops
 *  tokens are mutually unacceptable and a leak of one derived key stays local. */
import { hkdfSync, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from '../lib/keyedQueue.ts';
import { writeAtomic } from '../lib/atomicFile.ts';
import { signHS256, verifyHS256 } from '../lib/jwt.ts';
import {
  getJwtSecret,
  hashPassword,
  validPassword,
  validUsername,
} from '../accounts.ts';

export interface OpsAccount {
  id: string;
  username: string;
  passwordHash: string;
  tokenVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface OpsAccountPublic {
  id: string;
  username: string;
  createdAt: number;
}

const DIR = fileURLToPath(new URL('../../data/ops/', import.meta.url));
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const OPS_TOKEN_TTL = 12 * 3600;

let index: Map<string, OpsAccount> | null = null;
let indexLoad: Promise<Map<string, OpsAccount>> | null = null;
const enqueue = createKeyedQueue();
let mutationTail: Promise<void> = Promise.resolve();

/** Serialize operations whose invariants span the whole collection (unique username). */
function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function toPublic(a: OpsAccount): OpsAccountPublic {
  return { id: a.id, username: a.username, createdAt: a.createdAt };
}

function normalize(raw: unknown): OpsAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) return null;
  if (typeof v.username !== 'string' || !validUsername(v.username)) return null;
  if (typeof v.passwordHash !== 'string' || !v.passwordHash.includes(':')) return null;
  return {
    id: v.id,
    username: v.username,
    passwordHash: v.passwordHash,
    tokenVersion: Math.max(0, Math.floor(Number(v.tokenVersion) || 0)),
    createdAt: Number.isFinite(Number(v.createdAt)) ? Number(v.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : Date.now(),
  };
}

async function load(): Promise<Map<string, OpsAccount>> {
  if (index) return index;
  if (!indexLoad) {
    indexLoad = (async () => {
      await mkdir(DIR, { recursive: true });
      const map = new Map<string, OpsAccount>();
      for (const f of await readdir(DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const a = normalize(JSON.parse(await readFile(DIR + f, 'utf8')));
          if (!a || a.id !== f.slice(0, -'.json'.length)) continue;
          map.set(a.id, a);
        } catch {
          console.warn('[ops] skipping corrupt operator', f);
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

async function put(account: OpsAccount): Promise<OpsAccount> {
  return enqueue(account.id, async () => {
    const map = await load();
    await mkdir(DIR, { recursive: true });
    await writeAtomic(DIR + account.id + '.json', JSON.stringify(account));
    map.set(account.id, account);
    return account;
  });
}

export async function countOpsAccounts(): Promise<number> {
  return (await load()).size;
}

export async function listOpsAccounts(): Promise<OpsAccount[]> {
  return [...(await load()).values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getOpsAccount(id: string): Promise<OpsAccount | undefined> {
  return (await load()).get(id);
}

export async function findOpsByUsername(username: string): Promise<OpsAccount | undefined> {
  const u = username.trim().toLowerCase();
  return (await listOpsAccounts()).find((a) => a.username.toLowerCase() === u);
}

export function createOpsAccount(input: { username: string; password: string }): Promise<OpsAccount> {
  return enqueueMutation(async () => {
    if (!validUsername(input.username)) throw Object.assign(new Error('invalid username'), { status: 400 });
    if (!validPassword(input.password)) throw Object.assign(new Error('password too short'), { status: 400 });
    if (await findOpsByUsername(input.username))
      throw Object.assign(new Error('username taken'), { status: 409 });
    const now = Date.now();
    return put({
      id: randomUUID(),
      username: input.username,
      passwordHash: await hashPassword(input.password),
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export function deleteOpsAccount(id: string): Promise<boolean> {
  return enqueueMutation(() =>
    enqueue(id, async () => {
      const map = await load();
      if (!map.has(id)) return false;
      await rm(DIR + id + '.json', { force: true });
      map.delete(id);
      return true;
    }),
  );
}

/** Peer password reset; every outstanding token of the target dies with it. */
export function setOpsPassword(id: string, password: string): Promise<OpsAccount | undefined> {
  return enqueueMutation(async () => {
    if (!validPassword(password)) throw Object.assign(new Error('password too short'), { status: 400 });
    const current = await getOpsAccount(id);
    if (!current) return undefined;
    return put({
      ...current,
      passwordHash: await hashPassword(password),
      tokenVersion: current.tokenVersion + 1,
      updatedAt: Date.now(),
    });
  });
}

export function bumpOpsTokenVersion(id: string): Promise<OpsAccount | undefined> {
  return enqueueMutation(async () => {
    const current = await getOpsAccount(id);
    if (!current) return undefined;
    return put({ ...current, tokenVersion: current.tokenVersion + 1, updatedAt: Date.now() });
  });
}

// ---------- tokens (typ 'ops', 12h, no refresh) ----------

let opsSecret: Buffer | null = null;

function getOpsSecret(): Buffer {
  opsSecret ??= Buffer.from(
    hkdfSync('sha256', getJwtSecret(), Buffer.alloc(0), 'nianxiang-ops', 32),
  );
  return opsSecret;
}

export function issueOpsToken(account: OpsAccount): { token: string; expiresIn: number } {
  const iat = Math.floor(Date.now() / 1000);
  return {
    token: signHS256(
      { sub: account.id, typ: 'ops', tv: account.tokenVersion, iat, exp: iat + OPS_TOKEN_TTL },
      getOpsSecret(),
    ),
    expiresIn: OPS_TOKEN_TTL,
  };
}

/** Loads the live record on every request: a deleted operator's still-unexpired
 *  token fails here, and logout/password-change revokes via tokenVersion. */
export async function resolveOpsToken(token: string): Promise<OpsAccount | null> {
  const claims = verifyHS256(token, getOpsSecret());
  if (!claims || claims.typ !== 'ops') return null;
  const account = await getOpsAccount(String(claims.sub));
  if (!account || Number(claims.tv) !== account.tokenVersion) return null;
  return account;
}

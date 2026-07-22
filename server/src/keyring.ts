/** In-memory session keyring. Populated whenever the server sees a password
 *  (login / register / unlock / password change); never persisted — a restart
 *  locks all data until members re-enter their passwords (423 E_KEYS_LOCKED).
 *  Sliding TTL matches the refresh-token lifetime; touched on every keyed request. */

const TTL_MS = 30 * 24 * 3600e3;
const SWEEP_MS = 5 * 60e3;

interface AccountEntry {
  udk: Buffer;
  priv: Buffer;
  familyId: string | null;
  expiresAt: number;
}

interface ScopeEntry {
  key: Buffer;
  expiresAt: number;
}

const accountKeys = new Map<string, AccountEntry>();
/** familyId → FK. Personal scopes resolve via the owner's UDK instead. */
const familyKeys = new Map<string, ScopeEntry>();

export interface UnlockEvent {
  accountId: string;
  familyId: string | null;
  /** scope the account currently works in: familyId ?? accountId */
  scopeId: string;
  udk: Buffer;
  priv: Buffer;
  /** family key when the account holds one (undefined for standalone accounts) */
  fk: Buffer | undefined;
}

type UnlockListener = (event: UnlockEvent) => void;
const listeners: UnlockListener[] = [];

export function onUnlock(listener: UnlockListener): void {
  listeners.push(listener);
}

export function putAccountKeys(
  accountId: string,
  familyId: string | null,
  udk: Buffer,
  priv: Buffer,
): void {
  accountKeys.set(accountId, { udk, priv, familyId, expiresAt: Date.now() + TTL_MS });
}

export function putFamilyKey(familyId: string, fk: Buffer): void {
  familyKeys.set(familyId, { key: fk, expiresAt: Date.now() + TTL_MS });
}

/** Fire deferred-task listeners after keys are installed. */
export function notifyUnlock(event: UnlockEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn('[keyring] unlock listener failed:', e);
    }
  }
}

export function getUdk(accountId: string): Buffer | undefined {
  const entry = accountKeys.get(accountId);
  return entry && entry.expiresAt > Date.now() ? entry.udk : undefined;
}

export function getPriv(accountId: string): Buffer | undefined {
  const entry = accountKeys.get(accountId);
  return entry && entry.expiresAt > Date.now() ? entry.priv : undefined;
}

/** Scope key: FK for a family scope, the owner's UDK for a personal scope. */
export function getScopeKey(scopeId: string): Buffer | undefined {
  const fam = familyKeys.get(scopeId);
  if (fam && fam.expiresAt > Date.now()) return fam.key;
  return getUdk(scopeId);
}

export function getFamilyKey(familyId: string): Buffer | undefined {
  const entry = familyKeys.get(familyId);
  return entry && entry.expiresAt > Date.now() ? entry.key : undefined;
}

/** Slide TTLs for an active session (account + its family scope). */
export function touch(accountId: string): void {
  const entry = accountKeys.get(accountId);
  if (!entry) return;
  entry.expiresAt = Date.now() + TTL_MS;
  if (entry.familyId) {
    const fam = familyKeys.get(entry.familyId);
    if (fam) fam.expiresAt = Date.now() + TTL_MS;
  }
}

/** Logout / token revocation: drop the account's keys; drop the family key when
 *  no other member of that family still holds a keyring entry. */
export function wipe(accountId: string): void {
  const entry = accountKeys.get(accountId);
  accountKeys.delete(accountId);
  if (!entry?.familyId) return;
  for (const other of accountKeys.values()) {
    if (other.familyId === entry.familyId) return;
  }
  familyKeys.delete(entry.familyId);
}

/** Membership change: rebind the account's scope inside the keyring. */
export function setFamily(accountId: string, familyId: string | null): void {
  const entry = accountKeys.get(accountId);
  if (entry) entry.familyId = familyId;
}

/** Family teardown (ops dissolution): forget the live family key immediately. */
export function dropFamilyKey(familyId: string): void {
  familyKeys.delete(familyId);
}

/** Ops introspection: counts only — never the keys themselves. */
export function stats(): { unlockedAccounts: number; unlockedFamilies: number } {
  const now = Date.now();
  let unlockedAccounts = 0;
  let unlockedFamilies = 0;
  for (const entry of accountKeys.values()) if (entry.expiresAt > now) unlockedAccounts++;
  for (const entry of familyKeys.values()) if (entry.expiresAt > now) unlockedFamilies++;
  return { unlockedAccounts, unlockedFamilies };
}

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of accountKeys) if (entry.expiresAt <= now) accountKeys.delete(id);
  for (const [id, entry] of familyKeys) if (entry.expiresAt <= now) familyKeys.delete(id);
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startKeyringSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref();
}

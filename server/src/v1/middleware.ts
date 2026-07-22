import type { Context, MiddlewareHandler, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import * as accounts from '../accounts.ts';
import * as keyring from '../keyring.ts';
import { canUseAi } from '../entitlements.ts';
import type { Account } from '../accounts.ts';
import { err } from './errors.ts';

export type AuthVariables = {
  account: Account;
};

export type AppEnv = { Variables: AuthVariables };

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m?.[1]) return err(c, 'UNAUTHORIZED', 'missing bearer token');
  const account = await accounts.resolveAccessToken(m[1].trim());
  if (!account) return err(c, 'UNAUTHORIZED', 'invalid or expired token');
  c.set('account', account);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = c.get('account');
  if (!account || account.role !== 'admin') return err(c, 'FORBIDDEN', 'admin required');
  await next();
};

/** Data routes: auth + this account's keys present in the keyring. After a server
 *  restart the JWT is still valid but the keyring is empty — 423 tells the client
 *  to re-enter the password (POST /auth/unlock). */
export const requireKeys: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m?.[1]) return err(c, 'UNAUTHORIZED', 'missing bearer token');
  const account = await accounts.resolveAccessToken(m[1].trim());
  if (!account) return err(c, 'UNAUTHORIZED', 'invalid or expired token');
  c.set('account', account);
  if (!keyring.getUdk(account.id)) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  keyring.touch(account.id);
  await next();
};

/** Destructive scope operations: family owner, or a standalone account (its own scope). */
export const requireScopeOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = c.get('account');
  if (!account || !accounts.isScopeOwner(account))
    return err(c, 'FORBIDDEN', 'family owner required');
  await next();
};

/** Billing gate for AI routes — a stub today, the single future integration point. */
export const requireAiEntitlement: MiddlewareHandler<AppEnv> = async (c, next) => {
  const gate = canUseAi(c.get('account'));
  if (!gate.allowed) return err(c, 'FORBIDDEN', gate.reason);
  await next();
};

/** Number of trusted reverse-proxy hops in front of us (TRUST_PROXY). 0 = do not
 *  trust X-Forwarded-* at all. Each trusted proxy is expected to append one entry. */
function trustedHops(): number {
  return Number(process.env.TRUST_PROXY) || 0;
}

/** Read a forwarded header value from the trusted proxy nearest us, counting
 *  `TRUST_PROXY` hops from the RIGHT. Client-prepended entries sit on the left and
 *  cannot spoof the value once we skip the trusted tail. undefined when untrusted. */
export function forwardedHeader(c: Context, name: string): string | undefined {
  const hops = trustedHops();
  if (hops < 1) return undefined;
  const parts = c.req.header(name)?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts?.length) return undefined;
  return parts[parts.length - hops];
}

/** Per-user rate limit for expensive AI routes. */
export function userRateLimit(maxPerMin: number): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, { count: number; ts: number }>();
  return async (c, next) => {
    const id = c.get('account')?.id ?? clientIp(c);
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [key, value] of hits) if (now - value.ts > 60_000) hits.delete(key);
    }
    const h = hits.get(id);
    if (!h || now - h.ts > 60_000) hits.set(id, { count: 1, ts: now });
    else if (++h.count > maxPerMin) return err(c, 'RATE_LIMITED', 'too many requests');
    await next();
  };
}

function clientIp(c: Context): string {
  return forwardedHeader(c, 'x-forwarded-for') || getConnInfo(c).remote.address || 'local';
}

/** Login brute-force limit by IP. */
export function ipRateLimit(maxPerMin: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; ts: number }>();
  return async (c: Context, next: Next) => {
    const ip = clientIp(c);
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [key, value] of hits) if (now - value.ts > 60_000) hits.delete(key);
    }
    const h = hits.get(ip);
    if (!h || now - h.ts > 60_000) hits.set(ip, { count: 1, ts: now });
    else if (++h.count > maxPerMin) return err(c, 'RATE_LIMITED', 'too many login attempts');
    await next();
  };
}

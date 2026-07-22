/** Shared HS256 JWT primitives. The secret is caller-supplied: user tokens sign
 *  with JWT_SECRET directly, ops tokens with an HKDF-derived key, so the two
 *  trust domains never accept each other's signatures. */
import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export function signHS256(payload: object, secret: string | Buffer): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Signature, structure, sub and exp checked here; typ/tv semantics are the caller's. */
export function verifyHS256(token: string, secret: string | Buffer): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  // Signatures are always recomputed with HS256, so alg confusion is not
  // exploitable today — the explicit check guards future refactors.
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (head.alg !== 'HS256' || head.typ !== 'JWT') return null;
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return null;
    return claims;
  } catch {
    return null;
  }
}

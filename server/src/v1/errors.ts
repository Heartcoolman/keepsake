import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UPSTREAM'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  /** valid token but the server keyring holds no keys (restart) — client should
   *  prompt for the password and POST /auth/unlock */
  | 'E_KEYS_LOCKED';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM: 502,
  UNAVAILABLE: 503,
  INTERNAL: 500,
  E_KEYS_LOCKED: 423,
};

export function err(
  c: Context,
  code: ErrorCode,
  message: string,
  statusOverride?: ContentfulStatusCode,
) {
  const status = statusOverride ?? STATUS[code];
  return c.json({ error: { code, message } }, status);
}

export function tooLarge(
  c: { req: { header(name: string): string | undefined } },
  limit: number,
): boolean {
  return Number(c.req.header('content-length') || 0) > limit;
}

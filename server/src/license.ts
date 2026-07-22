// 授权令牌校验。按 LICENSE(Elastic License 2.0)条款,禁止移动、修改、
// 禁用或绕过本许可密钥功能(license key functionality)。
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

const LICENSE_PUBLIC_KEY_B64 = 'b4oXb+hUg/cNkbbbj8hEl1u2h94XkccR6J1DBxJ8z/o=';
const TOKEN_PREFIX = 'NX1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface LicenseInfo {
  licensee: string;
  edition: string;
  issuedAt: string;
  expiresAt: string | null;
}

export type LicenseCheck = { ok: true; info: LicenseInfo } | { ok: false; reason: string };

function publicKeyFromRaw(rawB64: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
}

export function verifyLicenseToken(
  token: string,
  publicKeyB64: string = LICENSE_PUBLIC_KEY_B64,
  now: Date = new Date(),
): LicenseCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed token' };
  }
  const [prefix, payloadB64, sigB64] = parts;
  const signature = Buffer.from(sigB64, 'base64url');
  let key: KeyObject;
  try {
    key = publicKeyFromRaw(publicKeyB64);
  } catch {
    return { ok: false, reason: 'bad public key' };
  }
  const signed = Buffer.from(`${prefix}.${payloadB64}`, 'utf8');
  if (signature.length !== 64 || !verify(null, signed, key, signature)) {
    return { ok: false, reason: 'invalid signature' };
  }
  let payload: Partial<LicenseInfo> | null;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid payload' };
  }
  if (
    !payload ||
    typeof payload.licensee !== 'string' || !payload.licensee ||
    typeof payload.edition !== 'string' ||
    typeof payload.issuedAt !== 'string' ||
    (payload.expiresAt != null && typeof payload.expiresAt !== 'string')
  ) {
    return { ok: false, reason: 'invalid payload' };
  }
  const expiresAt = payload.expiresAt ?? null;
  if (expiresAt) {
    const exp = Date.parse(expiresAt);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'invalid payload' };
    if (now.getTime() > exp) return { ok: false, reason: `license expired at ${expiresAt}` };
  }
  return {
    ok: true,
    info: { licensee: payload.licensee, edition: payload.edition, issuedAt: payload.issuedAt, expiresAt },
  };
}

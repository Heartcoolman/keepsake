/** At-rest encryption primitives: scrypt KDF, AES-256-GCM envelopes, binary blob
 *  framing, and X25519 sealed boxes (ephemeral ECDH + HKDF) for key grants.
 *  Node built-ins only. Every encrypt call uses a fresh random IV. */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Versioned AES-256-GCM envelope for JSON fields and wrapped keys. */
export interface Envelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string; // base64url, 12B
  ct: string; // base64url, ciphertext ‖ auth tag
}

/** Envelope sealed to an X25519 public key via an ephemeral keypair. */
export interface SealedBox extends Envelope {
  epk: string; // base64url, 32B ephemeral public key
}

export function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return e.v === 1 && e.alg === 'aes-256-gcm' && typeof e.iv === 'string' && typeof e.ct === 'string';
}

export function isSealedBox(v: unknown): v is SealedBox {
  return isEnvelope(v) && typeof (v as unknown as Record<string, unknown>).epk === 'string';
}

export function randomKey(len = KEY_LEN): Buffer {
  return randomBytes(len);
}

/** KEK from a password. The salt must be distinct from the auth-hash salt. */
export function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password, salt, KEY_LEN);
}

function gcmEncrypt(plain: Buffer, key: Buffer): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

function gcmDecrypt(env: Envelope, key: Buffer): Buffer {
  const iv = Buffer.from(env.iv, 'base64url');
  const data = Buffer.from(env.ct, 'base64url');
  if (iv.length !== IV_LEN || data.length < TAG_LEN) throw new Error('malformed envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(data.length - TAG_LEN));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_LEN)), decipher.final()]);
}

export const wrapKey = (raw: Buffer, kek: Buffer): Envelope => gcmEncrypt(raw, kek);
export const unwrapKey = (env: Envelope, kek: Buffer): Buffer => gcmDecrypt(env, kek);

export function encryptJson(obj: unknown, key: Buffer): Envelope {
  return gcmEncrypt(Buffer.from(JSON.stringify(obj), 'utf8'), key);
}

export function decryptJson<T>(env: Envelope, key: Buffer): T {
  return JSON.parse(gcmDecrypt(env, key).toString('utf8')) as T;
}

// ---------- binary blob framing: MAGIC(4) | iv(12) | ciphertext ‖ tag ----------

/** ASCII 'NX1E' — cannot collide with JPEG (FF D8 FF) or JSON ('{'). */
const MAGIC = Buffer.from('NX1E');

export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length > MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, 4).equals(MAGIC);
}

export function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([MAGIC, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function decryptBuffer(framed: Buffer, key: Buffer): Buffer {
  if (!isEncryptedBuffer(framed)) throw new Error('not an encrypted buffer');
  const iv = framed.subarray(4, 4 + IV_LEN);
  const body = framed.subarray(4 + IV_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(body.subarray(body.length - TAG_LEN));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_LEN)), decipher.final()]);
}

// ---------- X25519 sealed box ----------

/** Raw 32-byte keys via JWK export (this Node build rejects format:'raw' for OKP). */
export function generateX25519KeyPair(): { pub: Buffer; priv: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { pub: Buffer.from(pubJwk.x, 'base64url'), priv: Buffer.from(privJwk.d, 'base64url') };
}

function publicKeyObj(pubRaw: Buffer) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: pubRaw.toString('base64url') },
    format: 'jwk',
  });
}

function privateKeyObj(privRaw: Buffer, pubRaw: Buffer) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: pubRaw.toString('base64url'),
      d: privRaw.toString('base64url'),
    },
    format: 'jwk',
  });
}

function sealKey(shared: Buffer, epkRaw: Buffer, recipientPubRaw: Buffer): Buffer {
  const info = Buffer.concat([Buffer.from('nx-seal-v1'), epkRaw, recipientPubRaw]);
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, KEY_LEN));
}

/** Encrypt to a recipient's public key; only the private-key holder can open it. */
export function sealToPub(recipientPubRaw: Buffer, plain: Buffer): SealedBox {
  const eph = generateKeyPairSync('x25519');
  const ephJwk = eph.publicKey.export({ format: 'jwk' }) as { x: string };
  const epkRaw = Buffer.from(ephJwk.x, 'base64url');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObj(recipientPubRaw) });
  const env = gcmEncrypt(plain, sealKey(shared, epkRaw, recipientPubRaw));
  return { ...env, epk: epkRaw.toString('base64url') };
}

export function openSealed(sealed: SealedBox, privRaw: Buffer, pubRaw: Buffer): Buffer {
  const epkRaw = Buffer.from(sealed.epk, 'base64url');
  const shared = diffieHellman({
    privateKey: privateKeyObj(privRaw, pubRaw),
    publicKey: publicKeyObj(epkRaw),
  });
  return gcmDecrypt(sealed, sealKey(shared, epkRaw, pubRaw));
}

// ---------- recovery codes ----------

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** 8×4 chars from a 160-bit random value, e.g. XXXX-XXXX-…; shown once, never stored. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += RECOVERY_ALPHABET[(acc >> bits) & 31];
    }
  }
  return out.slice(0, 32).replace(/(.{4})(?=.)/g, '$1-');
}

/** Normalize user input: uppercase, drop separators. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

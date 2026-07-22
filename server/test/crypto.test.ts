import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptBuffer,
  decryptJson,
  deriveKek,
  encryptBuffer,
  encryptJson,
  generateRecoveryCode,
  generateX25519KeyPair,
  isEncryptedBuffer,
  normalizeRecoveryCode,
  openSealed,
  randomKey,
  sealToPub,
  unwrapKey,
  wrapKey,
} from '../src/crypto.ts';

test('kdf is deterministic per salt', async () => {
  const salt = Buffer.alloc(16, 7);
  const a = await deriveKek('correct horse', salt);
  const b = await deriveKek('correct horse', salt);
  const c = await deriveKek('correct horse', Buffer.alloc(16, 8));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 32);
});

test('json envelope round-trip, fresh IV each call', () => {
  const key = randomKey();
  const obj = { title: '海边的下午', chat: [{ role: 'user', content: '你好' }] };
  const e1 = encryptJson(obj, key);
  const e2 = encryptJson(obj, key);
  assert.notEqual(e1.iv, e2.iv);
  assert.deepEqual(decryptJson(e1, key), obj);
  assert.throws(() => decryptJson(e1, randomKey()));
});

test('key wrap round-trip', () => {
  const kek = randomKey();
  const udk = randomKey();
  assert.deepEqual(unwrapKey(wrapKey(udk, kek), kek), udk);
});

test('buffer framing: magic detection + round-trip + jpeg passthrough', () => {
  const key = randomKey();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomKey(64)]);
  assert.equal(isEncryptedBuffer(jpeg), false);
  const enc = encryptBuffer(jpeg, key);
  assert.equal(isEncryptedBuffer(enc), true);
  assert.deepEqual(decryptBuffer(enc, key), jpeg);
  assert.throws(() => decryptBuffer(enc, randomKey()));
});

test('sealed box: only the recipient private key opens it', () => {
  const alice = generateX25519KeyPair();
  const bob = generateX25519KeyPair();
  const fk = randomKey();
  const sealed = sealToPub(alice.pub, fk);
  assert.deepEqual(openSealed(sealed, alice.priv, alice.pub), fk);
  assert.throws(() => openSealed(sealed, bob.priv, bob.pub));
});

test('recovery code shape + normalization', () => {
  const code = generateRecoveryCode();
  assert.match(code, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
  assert.equal(normalizeRecoveryCode(code.toLowerCase().replaceAll('-', ' ')), code.replaceAll('-', ''));
});

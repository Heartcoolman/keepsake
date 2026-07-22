import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLicenseToken } from '../src/license.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' });
const pubB64 = spki.subarray(spki.length - 32).toString('base64');

function issue(payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(null, Buffer.from(`NX1.${payloadB64}`), privateKey).toString('base64url');
  return `NX1.${payloadB64}.${sig}`;
}

const base = { licensee: 'Test User', edition: 'full', issuedAt: '2026-07-22', expiresAt: null };

test('valid license verifies and exposes payload', () => {
  const check = verifyLicenseToken(issue(base), pubB64);
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.equal(check.info.licensee, 'Test User');
    assert.equal(check.info.edition, 'full');
    assert.equal(check.info.expiresAt, null);
  }
});

test('tampered payload is rejected', () => {
  const [prefix, , sig] = issue(base).split('.');
  const forged = Buffer.from(JSON.stringify({ ...base, licensee: 'Mallory' })).toString('base64url');
  assert.equal(verifyLicenseToken(`${prefix}.${forged}.${sig}`, pubB64).ok, false);
});

test('expired license is rejected', () => {
  const token = issue({ ...base, expiresAt: '2026-01-01T00:00:00Z' });
  const check = verifyLicenseToken(token, pubB64, new Date('2026-07-22'));
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /expired/);
});

test('future expiry passes', () => {
  const token = issue({ ...base, expiresAt: '2027-01-01T00:00:00Z' });
  assert.equal(verifyLicenseToken(token, pubB64, new Date('2026-07-22')).ok, true);
});

test('token signed by a foreign key fails against the embedded key', () => {
  assert.equal(verifyLicenseToken(issue(base)).ok, false);
});

test('malformed tokens are rejected', () => {
  for (const t of ['', 'NX1', 'NX1..', 'nope.abc.def', 'NX1.abc', `NX1.${'x'.repeat(20)}.short`]) {
    assert.equal(verifyLicenseToken(t, pubB64).ok, false, `should reject: ${t}`);
  }
});

test('missing payload fields are rejected', () => {
  for (const bad of [{}, { licensee: '' }, { licensee: 'A' }, { licensee: 'A', edition: 'full' }]) {
    assert.equal(verifyLicenseToken(issue(bad), pubB64).ok, false);
  }
});

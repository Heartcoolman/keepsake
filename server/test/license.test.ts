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

// ---- billing claims. Tokens issued before these existed must keep working unchanged,
// which is why both are optional rather than defaulted at the schema level.

test('a token without billing claims grants everything', () => {
  const check = verifyLicenseToken(issue(base), pubB64);
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.equal(check.info.seats, null, 'no seat cap');
    assert.equal(check.info.plans, null, 'every plan grantable');
  }
});

test('seats and plans are carried through', () => {
  const check = verifyLicenseToken(
    issue({ ...base, seats: 4, plans: ['free', 'standard'] }),
    pubB64,
  );
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.equal(check.info.seats, 4);
    assert.deepEqual(check.info.plans, ['free', 'standard']);
  }
});

test('a fractional seat count is floored, not rounded up', () => {
  const check = verifyLicenseToken(issue({ ...base, seats: 4.9 }), pubB64);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.info.seats, 4);
});

// NaN/Infinity are not tested here: JSON.stringify writes them as null, which the
// verifier reads as "claim absent" — they cannot reach it through a real token.
test('nonsensical billing claims are rejected rather than coerced', () => {
  for (const bad of [
    { seats: 0 },
    { seats: -1 },
    { seats: 'four' },
    { plans: 'standard' },
    { plans: [1, 2] },
    { plans: ['free', null] },
  ]) {
    assert.equal(
      verifyLicenseToken(issue({ ...base, ...bad }), pubB64).ok,
      false,
      `should reject: ${JSON.stringify(bad)}`,
    );
  }
});

test('the billing claims are signed like the rest of the payload', () => {
  const token = issue({ ...base, seats: 2 });
  const [prefix, , sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...base, seats: 999 })).toString('base64url');
  assert.equal(verifyLicenseToken(`${prefix}.${forged}.${sig}`, pubB64).ok, false);
});

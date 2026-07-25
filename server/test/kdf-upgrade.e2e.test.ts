/** Accounts written under the original scrypt profile must keep working and must
 *  drift forward to the current cost on login — without that, the profile can
 *  never be raised again. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auth, json, startServer, uploadForm } from './helpers.ts';
import { KDF_CURRENT, deriveKek, scryptWith, unwrapKey, wrapKey } from '../src/crypto.ts';

const PASSWORD = 'password123';

/** Rewrite one account record as if it had been created before KDF versioning:
 *  profile-1 wraps, profile-1 auth hash in the legacy `salt:hash` form, and no
 *  version fields at all. */
async function downgradeToProfile1(accountsDir: string): Promise<string> {
  const files = (await readdir(accountsDir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'expected exactly one account');
  const path = resolve(accountsDir, files[0]!);
  const account = JSON.parse(await readFile(path, 'utf8')) as Record<string, string | number>;

  const currentKek = await deriveKek(PASSWORD, Buffer.from(account.kekSalt as string, 'base64url'), KDF_CURRENT);
  const udk = unwrapKey(account.encUdk as never, currentKek);
  const priv = unwrapKey(account.encPrivKey as never, currentKek);

  const kekSalt = randomBytes(16);
  const legacyKek = await deriveKek(PASSWORD, kekSalt, 1);
  account.kekSalt = kekSalt.toString('base64url');
  account.encUdk = wrapKey(udk, legacyKek) as never;
  account.encPrivKey = wrapKey(priv, legacyKek) as never;
  delete account.kdfVersion;

  const hashSalt = randomBytes(16);
  const legacyHash = await scryptWith(PASSWORD, hashSalt, 64, 1);
  account.passwordHash = `${hashSalt.toString('base64url')}:${legacyHash.toString('base64url')}`;

  await writeFile(path, JSON.stringify(account));
  return path;
}

test('legacy scrypt profile still logs in and is upgraded in place', { timeout: 60_000 }, async () => {
  const server = await startServer(7);
  try {
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'legacy_kdf', password: PASSWORD, familyName: '旧家' }),
    });
    assert.equal(boot.response.status, 200);

    const entryId = crypto.randomUUID();
    assert.equal(
      (await fetch(`${server.base}/api/v1/entries`, {
        method: 'POST',
        headers: auth(boot.body.accessToken),
        body: uploadForm(entryId),
      })).status,
      201,
    );
    const patched = await json(server.base, `/api/v1/entries/${entryId}`, {
      method: 'PATCH',
      headers: auth(boot.body.accessToken),
      body: JSON.stringify({ diaryText: '写在升级之前的日记' }),
    });
    assert.equal(patched.response.status, 200);

    // ---------- rewrite the record as a pre-versioning account ----------
    await server.stop();
    const path = await downgradeToProfile1(resolve(server.dataDir, 'accounts'));
    const downgraded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(downgraded.kdfVersion, undefined);
    assert.ok(!String(downgraded.passwordHash).startsWith('s'));
    await server.restart();

    // ---------- login still works, and the wraps still open ----------
    const login = await json(server.base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'legacy_kdf', password: PASSWORD }),
    });
    assert.equal(login.response.status, 200, 'legacy profile must still authenticate');
    const entry = await json(server.base, `/api/v1/entries/${entryId}`, {
      headers: auth(login.body.accessToken),
    });
    assert.equal(entry.body.diaryText, '写在升级之前的日记', 'data written pre-upgrade stays readable');

    // ---------- and the record has been rewritten at the current cost ----------
    const upgraded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(upgraded.kdfVersion, KDF_CURRENT, 'key wraps upgraded');
    assert.equal(
      String(upgraded.passwordHash).startsWith(`s${KDF_CURRENT}:`),
      true,
      'auth hash upgraded to the versioned form',
    );
    assert.notEqual(upgraded.kekSalt, downgraded.kekSalt, 'a fresh salt accompanies the re-wrap');

    // ---------- the upgraded material round-trips through a real restart ----------
    await server.restart();
    const relogin = await json(server.base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'legacy_kdf', password: PASSWORD }),
    });
    assert.equal(relogin.response.status, 200);
    const afterUpgrade = await json(server.base, `/api/v1/entries/${entryId}`, {
      headers: auth(relogin.body.accessToken),
    });
    assert.equal(afterUpgrade.body.diaryText, '写在升级之前的日记');

    // a wrong password must still be rejected at the new profile
    const bad = await json(server.base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'legacy_kdf', password: 'not-the-password' }),
    });
    assert.equal(bad.response.status, 401);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver logs:\n${server.logs()}`);
  } finally {
    await server.cleanup();
  }
});

/** JWT_SECRET is deployment configuration: whoever runs the server can read it and
 *  can also read data/accounts/<id>.json, which holds the account id, role and
 *  tokenVersion in the clear. That is everything a signature-valid access token
 *  needs — so token validity alone must NOT grant decryption, or the operator can
 *  mint a token for any account and be served its plaintext off the keyring entry
 *  the real owner left behind.
 *
 *  These tests forge tokens exactly the way that operator would, and pin the line:
 *  a forged token still authenticates (it is, after all, correctly signed) but is
 *  refused by every route that would decrypt, because it cannot carry the binding
 *  derived from the account's UDK. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { signHS256 } from '../src/lib/jwt.ts';
import { auth, json, startServer } from './helpers.ts';

/** Same value helpers.ts starts the server with — i.e. what the operator knows. */
const SERVER_JWT_SECRET = 'e2e-secret-that-is-long-enough';

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const forge = (claims: Record<string, unknown>): string => signHS256(claims, SERVER_JWT_SECRET);

test('a token forged with JWT_SECRET cannot open encrypted data', { timeout: 60_000 }, async () => {
  const server = await startServer(7);
  try {
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_bind', password: 'password123', familyName: '绑定家' }),
    });
    assert.equal(boot.response.status, 200);
    const real = boot.body.accessToken as string;
    const realClaims = claimsOf(real);

    // The real token carries a binding at all — without this the rest proves nothing.
    assert.ok(typeof realClaims.bnd === 'string' && realClaims.bnd, 'issued token must be bound');
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(real) })).response.status,
      200,
      'precondition: the genuine token reads data',
    );

    // ---------- the operator's forgery: same account, same version, no binding ----------
    const { bnd: _dropped, ...unbound } = realClaims;
    const forgedUnbound = forge(unbound);
    assert.notEqual(forgedUnbound, real);
    const unboundRead = await json(server.base, '/api/v1/entries', { headers: auth(forgedUnbound) });
    assert.equal(unboundRead.response.status, 401, 'unbound forgery must not read entries');

    // ---------- guessing the binding is no better ----------
    const forgedWrong = forge({ ...realClaims, bnd: 'f'.repeat(32) });
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(forgedWrong) })).response.status,
      401,
      'wrong binding must not read entries',
    );

    // Every keyed surface, not just the entry list: people and the relationship
    // graph are the shape an operator would go after once the entries are shut.
    for (const path of ['/api/v1/people', '/api/v1/graph', '/api/v1/me/profile']) {
      assert.equal(
        (await json(server.base, path, { headers: auth(forgedUnbound) })).response.status,
        401,
        `${path} must refuse an unbound token`,
      );
    }

    // ---------- family routes are gated too ----------
    // They pull the family key out of the keyring and drive irreversible work with
    // it (a member removal re-encrypts the whole scope), so plain authentication is
    // not enough. This sub-app is mounted at '/', so the guard has to be attached
    // per path — a `use('*')` here would also swallow /entries/changes below.
    assert.equal(
      (await json(server.base, '/api/v1/family', { headers: auth(forgedUnbound) })).response.status,
      401,
      'family routes must refuse an unbound token',
    );

    // …while the change feed, which carries no decrypted content, must stay open on
    // plain auth — it is what tells a locked client to resync.
    const feed = await fetch(`${server.base}/api/v1/entries/changes`, {
      headers: auth(boot.body.accessToken as string),
    });
    assert.equal(feed.status, 200, 'the change feed must not inherit a blanket key guard');
    await feed.body?.cancel();

    // ---------- the boundary, stated explicitly ----------
    // A forged token is still a valid signature, so it passes plain authentication.
    // What it buys is only what the operator could already read off disk (username,
    // role, family id) — never decrypted content.
    const me = await json(server.base, '/api/v1/auth/me', { headers: auth(forgedUnbound) });
    assert.equal(me.response.status, 200, 'forged token still authenticates — by design');
    assert.equal(me.body.user.username, 'owner_bind');

    // ---------- and it cannot be laundered into a bound one via refresh ----------
    const realRefreshClaims = claimsOf(boot.body.refreshToken as string);
    const { bnd: _r, ...unboundRefresh } = realRefreshClaims;
    const refreshForged = await json(server.base, '/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: forge(unboundRefresh) }),
    });
    assert.equal(refreshForged.response.status, 401, 'unbound refresh must be refused');

    // ---------- a genuine refresh keeps working and stays bound ----------
    const refreshed = await json(server.base, '/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: boot.body.refreshToken }),
    });
    assert.equal(refreshed.response.status, 200);
    assert.ok(claimsOf(refreshed.body.accessToken).bnd, 'rotation must carry the binding forward');
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(refreshed.body.accessToken) }))
        .response.status,
      200,
      'the rotated token still reads data',
    );

    // ---------- a harvested binding is revocable ----------
    // `bnd` rides in the token's readable payload, so anything that ever sees one
    // token learns it. If it were derived from the UDK alone it would be valid for
    // the account's lifetime — the UDK never changes — and one leaked token would
    // hand an operator permanent decryption. Mixing tokenVersion in means the
    // existing revocation levers (logout, password change, recovery) move it.
    const harvested = claimsOf(refreshed.body.accessToken as string).bnd;
    const changed = await json(server.base, '/api/v1/auth/me/password', {
      method: 'PATCH',
      headers: auth(refreshed.body.accessToken as string),
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'password456' }),
    });
    assert.equal(changed.response.status, 200);
    const freshClaims = claimsOf(changed.body.accessToken as string);
    assert.notEqual(freshClaims.bnd, harvested, 'the binding must move with tokenVersion');
    // the operator re-signs with the CURRENT version and the harvested binding
    assert.equal(
      (await json(server.base, '/api/v1/entries', {
        headers: auth(forge({ ...freshClaims, bnd: harvested })),
      })).response.status,
      401,
      'a harvested binding must not survive a password change',
    );
    // the legitimate new token still works
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(changed.body.accessToken) }))
        .response.status,
      200,
    );

    // ---------- binding survives a restart + unlock, so no client change is needed ----------
    await server.restart();
    const locked = await json(server.base, '/api/v1/entries', {
      headers: auth(changed.body.accessToken),
    });
    assert.equal(locked.response.status, 423, 'empty keyring after restart');
    const unlock = await json(server.base, '/api/v1/auth/unlock', {
      method: 'POST',
      headers: auth(changed.body.accessToken),
      body: JSON.stringify({ password: 'password456' }),
    });
    assert.equal(unlock.response.status, 200);
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(changed.body.accessToken) }))
        .response.status,
      200,
      'the pre-restart token is still bound — the UDK it binds to did not change',
    );
    // the forgery is still refused after the unlock it was waiting for
    assert.equal(
      (await json(server.base, '/api/v1/entries', { headers: auth(forgedUnbound) })).response.status,
      401,
      'an unlocked keyring must not rescue a forged token',
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver logs:\n${server.logs()}`);
  } finally {
    await server.cleanup();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { auth, json, startServer } from './helpers.ts';

/** Send a raw HTTP/1.1 request line — fetch() forbids TRACE/TRACK, and Node's http
 *  client mangles them, so hit the socket directly the way curl (or an attacker) would. */
function raw(base: string, method: string, path: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: ${u.hostname}:${u.port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', () => {
      const m = /^HTTP\/1\.\d (\d+)/.exec(buf);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on('error', reject);
  });
}

test('security hardening: headers, methods, robustness, recover', { timeout: 60_000 }, async () => {
  const server = await startServer(11);
  try {
    // --- security response headers on a real API response ---
    const health = await fetch(`${server.base}/api/v1/health`);
    assert.equal(health.status, 200);
    const csp = health.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP header carries frame-ancestors none');
    assert.ok(csp.includes('hf-mirror.com'), 'CSP keeps the HF depth-fallback domains');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(health.headers.get('strict-transport-security'), 'HSTS present');
    assert.equal(health.headers.get('x-permitted-cross-domain-policies'), 'none');

    // --- TRACE reaches the app and is rejected with 405 (XST primitive). TRACK is
    // rejected even earlier by Node's HTTP parser (400) — either way it is not served. ---
    assert.equal(await raw(server.base, 'TRACE', '/api/v1/health'), 405);
    assert.ok([400, 405].includes(await raw(server.base, 'TRACK', '/api/v1/health')), 'TRACK rejected');

    // --- bootstrap a warm session (keyring holds this owner's keys) ---
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'sec_owner', password: 'password123', displayName: 'Owner' }),
    });
    assert.equal(boot.response.status, 200);
    const owner = auth(boot.body.accessToken);

    // --- POST /entries with a JSON body is a clean 400, not a 500 ---
    const jsonEntry = await json(server.base, '/api/v1/entries', {
      method: 'POST', headers: owner, body: JSON.stringify({}),
    });
    assert.equal(jsonEntry.response.status, 400);
    assert.equal(jsonEntry.body.error.code, 'VALIDATION');

    // --- unknown memory id → 404, not a silent 200 no-op ---
    const rnd = crypto.randomUUID();
    const patchMem = await json(server.base, `/api/v1/me/memories/${rnd}`, {
      method: 'PATCH', headers: owner, body: JSON.stringify({ text: 'hi' }),
    });
    assert.equal(patchMem.response.status, 404);
    const delMem = await json(server.base, `/api/v1/me/memories/${rnd}`, {
      method: 'DELETE', headers: owner,
    });
    assert.equal(delMem.response.status, 404);

    // --- register a victim to exercise the recover flow (open registration by default) ---
    const reg = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'personal', username: 'sec_victim', password: 'password123', displayName: 'Victim' }),
    });
    assert.equal(reg.response.status, 201);
    const recoveryCode: string = reg.body.recoveryCode;
    assert.ok(recoveryCode, 'register returns a recovery code');

    // duplicate username still 409 (client UX needs it)
    const dup = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'personal', username: 'sec_victim', password: 'password123', displayName: 'Victim' }),
    });
    assert.equal(dup.response.status, 409);

    // --- recover has no username-existence oracle: a wrong code for a real user and
    // an unknown username return the IDENTICAL 401 shape ---
    const wrongCode = await json(server.base, '/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({
        username: 'sec_victim',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
        newPassword: 'newpass12345',
      }),
    });
    const ghost = await json(server.base, '/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({
        username: 'ghost_does_not_exist',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
        newPassword: 'newpass12345',
      }),
    });
    assert.equal(wrongCode.response.status, 401);
    assert.equal(ghost.response.status, 401);
    assert.deepEqual(wrongCode.body, ghost.body);

    // --- recover still works end-to-end with the real code, and rotates it ---
    const ok = await json(server.base, '/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({ username: 'sec_victim', recoveryCode, newPassword: 'brandnew12345' }),
    });
    assert.equal(ok.response.status, 200);
    assert.ok(ok.body.accessToken, 'recover issues a session');
    assert.ok(ok.body.recoveryCode && ok.body.recoveryCode !== recoveryCode, 'recovery code rotated');
  } finally {
    await server.cleanup();
  }
});

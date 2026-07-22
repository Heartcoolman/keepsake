import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServer(base: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

async function json(base: string, path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

test('v1 authentication, isolation, upload, SSE and legacy shutdown', { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(`${tmpdir()}/nianxiang-api-`);
  const copiedServer = resolve(temp, 'server');
  await mkdir(copiedServer, { recursive: true });
  await cp(resolve(SERVER_ROOT, 'src'), resolve(copiedServer, 'src'), { recursive: true });
  await cp(resolve(SERVER_ROOT, 'package.json'), resolve(copiedServer, 'package.json'));
  await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(copiedServer, 'node_modules'), 'dir');

  const port = 20_000 + (process.pid % 20_000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/src/index.ts'], {
    cwd: temp,
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_AI: '1',
      JWT_SECRET: 'e2e-secret-that-is-long-enough',
      ENABLE_LEGACY_API: '0',
      INFERENCE_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { logs += chunk.toString(); });

  try {
    await waitForServer(base, child);
    const health = await json(base, '/api/v1/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.bootstrapped, false);

    const bootstrap = (username: string) => json(base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'password123', displayName: username }),
    });
    const attempts = await Promise.all([bootstrap('admin_one'), bootstrap('admin_two')]);
    assert.deepEqual(attempts.map((item) => item.response.status).sort(), [200, 409]);
    const adminSession = attempts.find((item) => item.response.status === 200)!.body;
    const adminHeader = { authorization: `Bearer ${adminSession.accessToken}` };

    const legacy = await fetch(`${base}/api/entries`);
    assert.equal(legacy.status, 404);
    const noToken = await fetch(`${base}/api/v1/entries`);
    assert.equal(noToken.status, 401);

    // Admin password-management endpoints are gone by design (recovery codes only).
    const lastAdmin = await json(base, `/api/v1/users/${adminSession.user.id}`, {
      method: 'PATCH',
      headers: adminHeader,
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(lastAdmin.response.status, 404);

    // Bootstrap owner is a family account with a one-shot recovery code.
    assert.equal(adminSession.user.accountType, 'family');
    assert.ok(adminSession.user.familyId);
    assert.match(adminSession.recoveryCode, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);

    // Members register as personal accounts, then join via owner invite + accept.
    const registered = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal',
        username: 'member_one',
        password: 'password123',
        displayName: 'Member',
      }),
    });
    assert.equal(registered.response.status, 201);
    assert.equal(registered.body.user.accountType, 'personal');
    assert.equal(registered.body.user.familyId, null);
    const memberHeader = { authorization: `Bearer ${registered.body.accessToken}` };

    const invite = await json(base, '/api/v1/family/invites', {
      method: 'POST',
      headers: adminHeader,
      body: JSON.stringify({ username: 'member_one' }),
    });
    assert.equal(invite.response.status, 201);

    const myInvites = await json(base, '/api/v1/me/invites', { headers: memberHeader });
    assert.equal(myInvites.body.items.length, 1);
    const accepted = await json(base, `/api/v1/me/invites/${myInvites.body.items[0].id}/accept`, {
      method: 'POST', headers: memberHeader, body: '{}',
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.user.familyId, adminSession.user.familyId);

    const familyView = await json(base, '/api/v1/family', { headers: memberHeader });
    assert.equal(familyView.body.members.length, 2);

    const entryId = crypto.randomUUID();
    const form = new FormData();
    form.set('meta', JSON.stringify({ id: entryId, takenAt: Date.now(), status: 'new' }));
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    form.set('image', jpeg, 'image.jpg');
    form.set('thumb', jpeg, 'thumb.jpg');
    const upload = await fetch(`${base}/api/v1/entries`, { method: 'POST', headers: adminHeader, body: form });
    assert.equal(upload.status, 201);

    const adminEntries = await json(base, '/api/v1/entries', { headers: adminHeader });
    const memberEntries = await json(base, '/api/v1/entries', { headers: memberHeader });
    assert.equal(adminEntries.body.items.length, 1);
    assert.equal(memberEntries.body.items.length, 0);
    const hidden = await fetch(`${base}/api/v1/entries/${entryId}`, { headers: memberHeader });
    assert.equal(hidden.status, 404);

    const analyze = await json(base, `/api/v1/entries/${entryId}/analyze`, {
      method: 'POST', headers: adminHeader, body: '{}',
    });
    assert.equal(analyze.response.status, 200);
    const chat = await fetch(`${base}/api/v1/entries/${entryId}/chat`, {
      method: 'POST',
      headers: { ...adminHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    const stream = await chat.text();
    assert.match(stream, /"type":"delta"/);
    assert.match(stream, /"type":"done"/);

    // createdAt-only PATCH must move the memory date (was a silent no-op).
    const backdated = 1_650_000_000_000; // 2022-04
    const patchedDate = await json(base, `/api/v1/entries/${entryId}`, {
      method: 'PATCH', headers: adminHeader, body: JSON.stringify({ createdAt: backdated }),
    });
    assert.equal(patchedDate.response.status, 200);
    assert.equal(patchedDate.body.takenAt, backdated);
    assert.equal(patchedDate.body.createdAt, backdated);
    assert.equal(patchedDate.body.yearMonth, '2022-04');

    // Malformed chat messages must be a 400, not a 500.
    const badChat = await fetch(`${base}/api/v1/entries/${entryId}/chat`, {
      method: 'POST',
      headers: { ...adminHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [null] }),
    });
    assert.equal(badChat.status, 400);

    const malformed = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(typeof (await malformed.json()).error.code, 'string');
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver logs:\n${logs}`);
  } finally {
    if (child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(temp, { recursive: true, force: true });
  }
});

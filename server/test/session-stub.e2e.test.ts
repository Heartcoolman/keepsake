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

// Public builds ship stubbed session routes (the real orchestration lives in the
// private core submodule). They must degrade honestly: 501 + UNAVAILABLE, using
// the standard v1 error envelope. Skipped automatically when the real core is
// selected (the real routes respond 200/404 instead of 501).
test('session endpoints return 501 UNAVAILABLE in public builds', { timeout: 30_000 }, async (t) => {
  const temp = await mkdtemp(`${tmpdir()}/nianxiang-stub-`);
  const copiedServer = resolve(temp, 'server');
  await mkdir(copiedServer, { recursive: true });
  await cp(resolve(SERVER_ROOT, 'src'), resolve(copiedServer, 'src'), { recursive: true });
  await cp(resolve(SERVER_ROOT, 'package.json'), resolve(copiedServer, 'package.json'));
  await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(copiedServer, 'node_modules'), 'dir');

  const port = 22_000 + (process.pid % 20_000);
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

    const bootstrap = await fetch(`${base}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin_stub', password: 'password123', displayName: 'admin_stub' }),
    });
    assert.equal(bootstrap.status, 200);
    const session = await bootstrap.json();
    const auth = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };

    const open = await fetch(`${base}/api/v1/entries/some-id/session/open`, {
      method: 'POST', headers: auth, body: '{}',
    });
    if (open.status !== 501) {
      t.skip('real session orchestration is selected (private core) — stub assertions do not apply');
      return;
    }

    for (const endpoint of ['open', 'message', 'complete']) {
      const response = await fetch(`${base}/api/v1/entries/some-id/session/${endpoint}`, {
        method: 'POST', headers: auth, body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(response.status, 501, `session/${endpoint}`);
      const body = await response.json();
      assert.equal(body.error.code, 'UNAVAILABLE');
      assert.equal(typeof body.error.message, 'string');
    }

    const noToken = await fetch(`${base}/api/v1/entries/some-id/session/open`, { method: 'POST' });
    assert.equal(noToken.status, 401);
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

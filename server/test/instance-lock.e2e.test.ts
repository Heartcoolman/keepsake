/** A second process on the same data directory must refuse to start. The keyring,
 *  rate-limit counters and inference queue are process-local, so two instances corrupt
 *  quietly (split family keys, halved rate limits) instead of failing — the lock turns
 *  that into a startup error. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startServer } from './helpers.ts';

/** Boot a second server against an existing temp workspace; resolves with its outcome. */
function bootSecond(temp: string, port: number): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: temp,
      env: {
        ...process.env,
        PORT: String(port),
        MOCK_AI: '1',
        JWT_SECRET: 'e2e-secret-that-is-long-enough',
        INFERENCE_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (c) => { output += c.toString(); });
    child.stderr?.on('data', (c) => { output += c.toString(); });
    child.once('exit', (code) => done({ code, output }));
    // a lock failure exits immediately; anything still alive after 15s has started serving
    setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
        done({ code: null, output });
      }
    }, 15_000).unref();
  });
}

test('a second instance on the same data directory refuses to start', { timeout: 60_000 }, async (t) => {
  const server = await startServer(71);
  t.after(() => server.cleanup());

  const lockPath = resolve(server.dataDir, 'instance.lock');
  const held = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(typeof held.pid, 'number', 'lock records the holder pid');
  assert.ok(held.pid > 0);

  const second = await bootSecond(server.temp, 21_999);
  assert.equal(second.code, 1, `second instance should exit 1, got ${second.code}\n${second.output}`);
  assert.match(second.output, /\[lock\]/);
  assert.match(second.output, /another nianxiang process holds/);

  // the loser must not have taken the lock away from the running server
  const stillHeld = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(stillHeld.pid, held.pid, 'the running server still holds the lock');

  // and the first server is still serving
  const health = await fetch(`${server.base}/api/v1/health`);
  assert.equal(health.status, 200);
});

test('a lock left by a dead process is reclaimed', { timeout: 60_000 }, async (t) => {
  const server = await startServer(72);
  t.after(() => server.cleanup());
  const lockPath = resolve(server.dataDir, 'instance.lock');

  // SIGTERM releases it, so plant a lock naming a pid that cannot be running
  await server.stop();
  await rm(lockPath, { force: true });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 0x7ffffff0, startedAt: new Date().toISOString(), port: 1 }),
  );

  await server.restart();
  const health = await fetch(`${server.base}/api/v1/health`);
  assert.equal(health.status, 200, 'server starts over a stale lock');
  assert.match(server.logs(), /reclaiming stale/);
  const reclaimed = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.notEqual(reclaimed.pid, 0x7ffffff0, 'the planted pid was replaced');
  assert.ok(Number.isInteger(reclaimed.pid) && reclaimed.pid > 0);
});

test('an unreadable lock file does not wedge boot', { timeout: 60_000 }, async (t) => {
  const server = await startServer(73);
  t.after(() => server.cleanup());
  const lockPath = resolve(server.dataDir, 'instance.lock');

  await server.stop();
  await writeFile(lockPath, '{ truncated');

  await server.restart();
  const health = await fetch(`${server.base}/api/v1/health`);
  assert.equal(health.status, 200, 'server starts over a truncated lock');
  assert.match(server.logs(), /reclaiming stale/);
});

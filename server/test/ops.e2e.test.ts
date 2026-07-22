/** Ops console e2e: bootstrap/login, token-domain isolation, account
 *  disable/delete, family dissolution, registration policy, usage aggregation,
 *  audit hygiene, static page, backups. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { auth, json, scanForPlaintext, startServer, uploadForm } from './helpers.ts';

const OPS_TOKEN = 'ops-bootstrap-token-e2e';
const ENV_REG_CODE = 'env-reg-code-e2e';
const OPS_PASSWORD = 'ops-password-secret-1';

test('ops console end to end', { timeout: 120_000 }, async () => {
  const server = await startServer(3, {
    OPS_BOOTSTRAP_TOKEN: OPS_TOKEN,
    REGISTRATION_CODE: ENV_REG_CODE,
  });
  const { base, dataDir, cacheDir } = server;

  try {
    // ---------- static page is served from src (survives the harness copy) ----------
    const page = await fetch(`${base}/ops`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /念想 · 运维/);
    assert.equal((await fetch(`${base}/ops/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/ops/style.css`)).status, 200);

    // ---------- bootstrap gating ----------
    const wrongToken = await json(base, '/api/ops/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ token: 'nope', username: 'boss', password: OPS_PASSWORD }),
    });
    assert.equal(wrongToken.response.status, 401);

    const boot = await json(base, '/api/ops/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ token: OPS_TOKEN, username: 'boss', password: OPS_PASSWORD }),
    });
    assert.equal(boot.response.status, 201);
    assert.ok(boot.body.token);
    const opsAuth = auth(boot.body.token);

    const again = await json(base, '/api/ops/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ token: OPS_TOKEN, username: 'boss2', password: OPS_PASSWORD }),
    });
    assert.equal(again.response.status, 409);

    // ---------- user accounts: bootstrap a family + a standalone personal ----------
    const familyBoot = await json(base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'password123', familyName: '测试家庭' }),
    });
    assert.equal(familyBoot.response.status, 200);
    const ownerAuth = auth(familyBoot.body.accessToken);

    // env registration code is authoritative until ops-config exists
    const regNoCode = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'personal', username: 'solo', password: 'password123' }),
    });
    assert.equal(regNoCode.response.status, 401);
    const solo = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal', username: 'solo', password: 'password123', regCode: ENV_REG_CODE,
      }),
    });
    assert.equal(solo.response.status, 201);
    const soloAuth = auth(solo.body.accessToken);
    const soloId = solo.body.user.id as string;

    const upload = await fetch(`${base}/api/v1/entries`, {
      method: 'POST',
      headers: soloAuth,
      body: uploadForm('solo-entry-1'),
    });
    assert.equal(upload.status, 201);

    // ---------- token-domain isolation ----------
    const userOnOps = await json(base, '/api/ops/auth/me', { headers: ownerAuth });
    assert.equal(userOnOps.response.status, 401);
    const opsOnUser = await json(base, '/api/v1/auth/me', { headers: opsAuth });
    assert.equal(opsOnUser.response.status, 401);
    const opsOnData = await json(base, '/api/v1/entries', { headers: opsAuth });
    assert.equal(opsOnData.response.status, 401);

    // ---------- account listing ----------
    const accountList = await json(base, '/api/ops/accounts', { headers: opsAuth });
    assert.equal(accountList.response.status, 200);
    const soloRow = accountList.body.items.find((a: { username: string }) => a.username === 'solo');
    assert.ok(soloRow);
    assert.equal(soloRow.accountType, 'personal');
    assert.equal(soloRow.entryCount, 1);
    assert.ok(soloRow.storageBytes > 0);
    assert.equal(soloRow.hasCrypto, true);

    // ---------- disable kills live sessions, enable restores login ----------
    const disable = await json(base, `/api/ops/accounts/${soloId}`, {
      method: 'PATCH',
      headers: opsAuth,
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disable.response.status, 200);
    const rejected = await json(base, '/api/v1/entries', { headers: soloAuth });
    assert.equal(rejected.response.status, 401);
    const loginWhileDisabled = await json(base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'solo', password: 'password123' }),
    });
    assert.equal(loginWhileDisabled.response.status, 401);

    const enable = await json(base, `/api/ops/accounts/${soloId}`, {
      method: 'PATCH',
      headers: opsAuth,
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(enable.response.status, 200);
    const reLogin = await json(base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'solo', password: 'password123' }),
    });
    assert.equal(reLogin.response.status, 200);

    // ---------- registration policy: ops-config overrides env outright ----------
    const closeReg = await json(base, '/api/ops/registration', {
      method: 'PATCH',
      headers: opsAuth,
      body: JSON.stringify({ open: false }),
    });
    assert.equal(closeReg.response.status, 200);
    assert.equal(closeReg.body.open, false);
    // first ops write adopted the env code
    assert.equal(closeReg.body.codeRequired, true);
    const closed = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal', username: 'nobody', password: 'password123', regCode: ENV_REG_CODE,
      }),
    });
    assert.equal(closed.response.status, 403);

    // reopen with code:null → the still-set env var no longer applies
    await json(base, '/api/ops/registration', {
      method: 'PATCH',
      headers: opsAuth,
      body: JSON.stringify({ open: true, code: null }),
    });
    const openNoCode = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'personal', username: 'walkin', password: 'password123' }),
    });
    assert.equal(openNoCode.response.status, 201);

    // rotate to a fresh code → old env code rejected, new one accepted
    await json(base, '/api/ops/registration', {
      method: 'PATCH',
      headers: opsAuth,
      body: JSON.stringify({ code: 'fresh-code-2' }),
    });
    const oldCode = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal', username: 'stale', password: 'password123', regCode: ENV_REG_CODE,
      }),
    });
    assert.equal(oldCode.response.status, 401);
    const newCode = await json(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal', username: 'member1', password: 'password123', regCode: 'fresh-code-2',
      }),
    });
    assert.equal(newCode.response.status, 201);
    const member1Auth = auth(newCode.body.accessToken);
    const member1Id = newCode.body.user.id as string;

    // ---------- family flow → dissolution ----------
    const invite = await json(base, '/api/v1/family/invites', {
      method: 'POST',
      headers: ownerAuth,
      body: JSON.stringify({ username: 'member1' }),
    });
    assert.equal(invite.response.status, 201);
    const myInvites = await json(base, '/api/v1/me/invites', { headers: member1Auth });
    const accept = await json(base, `/api/v1/me/invites/${myInvites.body.items[0].id}/accept`, {
      method: 'POST',
      headers: member1Auth,
    });
    assert.equal(accept.response.status, 200);
    const familyId = accept.body.family.id as string;

    const memberUpload = await fetch(`${base}/api/v1/entries`, {
      method: 'POST',
      headers: member1Auth,
      body: uploadForm('member-entry-1'),
    });
    assert.equal(memberUpload.status, 201);

    // family member cannot be hard-deleted by ops
    const memberDelete = await json(base, `/api/ops/accounts/${member1Id}`, {
      method: 'DELETE',
      headers: opsAuth,
    });
    assert.equal(memberDelete.response.status, 409);

    // seed a face cache artifact for the family scope so dissolution has
    // something to destroy (inference is disabled in e2e)
    await mkdir(join(cacheDir, 'face'), { recursive: true });
    const fakeFaceCache = join(cacheDir, 'face', `${familyId}-${'a'.repeat(64)}.json`);
    await writeFile(fakeFaceCache, JSON.stringify({ enc: { v: 1, alg: 'aes-256-gcm', iv: 'x', ct: 'x' } }));

    const familyList = await json(base, '/api/ops/families', { headers: opsAuth });
    assert.equal(familyList.body.items.length, 1);
    assert.equal(familyList.body.items[0].members.length, 2);

    const dissolve = await json(base, `/api/ops/families/${familyId}`, {
      method: 'DELETE',
      headers: opsAuth,
    });
    assert.equal(dissolve.response.status, 200);
    assert.equal(dissolve.body.members, 2);

    // family record + scope data gone; second call is a clean 404
    assert.equal((await json(base, `/api/ops/families/${familyId}`, { method: 'DELETE', headers: opsAuth })).response.status, 404);
    const familyFiles = await readdir(join(dataDir, 'families')).catch(() => []);
    assert.equal(familyFiles.length, 0);
    const faceFiles = await readdir(join(cacheDir, 'face')).catch(() => [] as string[]);
    assert.ok(!faceFiles.some((f) => f.startsWith(`${familyId}-`)));
    for (const f of await readdir(join(dataDir, 'people')).catch(() => [] as string[])) {
      const person = JSON.parse(await readFile(join(dataDir, 'people', f), 'utf8')) as { scopeId?: string };
      assert.notEqual(person.scopeId, familyId);
    }

    // members detached, entries reset for rescan in the personal scope
    const memberEntry = JSON.parse(
      await readFile(join(dataDir, 'entries', 'member-entry-1.json'), 'utf8'),
    ) as { familyId: string | null; faceScannedAt: number; people: unknown[] };
    assert.equal(memberEntry.familyId, null);
    assert.equal(memberEntry.faceScannedAt, 0);
    assert.deepEqual(memberEntry.people, []);
    const ownerMe = await json(base, '/api/v1/auth/me', { headers: ownerAuth });
    assert.equal(ownerMe.body.user.familyId, null);
    assert.equal(ownerMe.body.user.accountType, 'family');

    // ---------- the dissolved owner rebuilds a family ----------
    const rebuild = await json(base, '/api/v1/family', {
      method: 'POST',
      headers: ownerAuth,
      body: JSON.stringify({ name: '新家庭' }),
    });
    assert.equal(rebuild.response.status, 201);
    assert.equal(rebuild.body.family.name, '新家庭');
    assert.equal(rebuild.body.user.familyId, rebuild.body.family.id);

    // ---------- hard delete of a standalone account purges its files ----------
    const soloEntryFiles = (await readdir(join(dataDir, 'entries'))).filter((f) => f.startsWith('solo-entry-1'));
    assert.ok(soloEntryFiles.length >= 3);
    await mkdir(join(dataDir, 'usage'), { recursive: true });
    await writeFile(
      join(dataDir, 'usage', `${soloId}-2026-07.json`),
      JSON.stringify({ accountId: soloId, yearMonth: '2026-07', calls: 3, promptTokens: 120, completionTokens: 45, estimatedCalls: 1, updatedAt: Date.now() }),
    );

    const purge = await json(base, `/api/ops/accounts/${soloId}`, { method: 'DELETE', headers: opsAuth });
    assert.equal(purge.response.status, 200);
    assert.ok(!(await readdir(join(dataDir, 'entries'))).some((f) => f.startsWith('solo-entry-1')));
    assert.ok(!(await readdir(join(dataDir, 'accounts'))).includes(`${soloId}.json`));
    assert.ok(!(await readdir(join(dataDir, 'usage'))).some((f) => f.startsWith(`${soloId}-`)));
    const peopleLeft = await scanForPlaintext([join(dataDir, 'people')], [soloId]);
    assert.deepEqual(peopleLeft, []);

    // ---------- usage aggregation joins usernames ----------
    const ownerId = familyBoot.body.user.id as string;
    await writeFile(
      join(dataDir, 'usage', `${ownerId}-2026-07.json`),
      JSON.stringify({ accountId: ownerId, yearMonth: '2026-07', calls: 7, promptTokens: 1000, completionTokens: 300, estimatedCalls: 0, updatedAt: Date.now() }),
    );
    const months = await json(base, '/api/ops/usage', { headers: opsAuth });
    assert.equal(months.response.status, 200);
    const julyRow = months.body.months.find((m: { yearMonth: string }) => m.yearMonth === '2026-07');
    assert.ok(julyRow);
    const detail = await json(base, '/api/ops/usage?month=2026-07', { headers: opsAuth });
    const ownerUsage = detail.body.items.find((u: { accountId: string }) => u.accountId === ownerId);
    assert.equal(ownerUsage.username, 'owner');
    assert.equal(ownerUsage.promptTokens, 1000);

    // ---------- system snapshot ----------
    const system = await json(base, '/api/ops/system', { headers: opsAuth });
    assert.equal(system.response.status, 200);
    assert.ok(system.body.counts.accounts >= 3);
    assert.ok(system.body.disk['data/entries'].files >= 1);
    assert.ok(system.body.migration.every((m: { legacyEntries: number }) => m.legacyEntries === 0));

    // ---------- backups ----------
    const backup = await json(base, '/api/ops/backups', { method: 'POST', headers: opsAuth });
    assert.equal(backup.response.status, 201);
    const backupRoot = join(dataDir, 'backups', backup.body.name);
    const backedUp = await readdir(backupRoot);
    assert.ok(backedUp.includes('data'));
    assert.ok(backedUp.includes('cache'));
    // no recursion: the copied data dir either lacks backups or holds an empty shell
    const nested = await readdir(join(backupRoot, 'data')).catch(() => [] as string[]);
    assert.ok(!nested.includes('backups'));
    assert.ok((await readdir(join(backupRoot, 'data', 'accounts'))).length >= 1);
    const backupList = await json(base, '/api/ops/backups', { headers: opsAuth });
    assert.equal(backupList.body.items.length, 1);
    const dropBackup = await json(base, `/api/ops/backups/${backup.body.name}`, { method: 'DELETE', headers: opsAuth });
    assert.equal(dropBackup.response.status, 200);
    assert.deepEqual((await json(base, '/api/ops/backups', { headers: opsAuth })).body.items, []);

    // ---------- operators: peer management + instant revocation ----------
    const second = await json(base, '/api/ops/operators', {
      method: 'POST',
      headers: opsAuth,
      body: JSON.stringify({ username: 'helper', password: 'helper-password-9' }),
    });
    assert.equal(second.response.status, 201);
    const helperLogin = await json(base, '/api/ops/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'helper', password: 'helper-password-9' }),
    });
    assert.equal(helperLogin.response.status, 200);
    const helperAuth = auth(helperLogin.body.token);
    assert.equal((await json(base, '/api/ops/auth/me', { headers: helperAuth })).response.status, 200);

    const dropHelper = await json(base, `/api/ops/operators/${second.body.operator.id}`, {
      method: 'DELETE',
      headers: opsAuth,
    });
    assert.equal(dropHelper.response.status, 200);
    // the deleted operator's unexpired token dies immediately
    assert.equal((await json(base, '/api/ops/auth/me', { headers: helperAuth })).response.status, 401);

    // logout revokes the current token
    const preLogout = await json(base, '/api/ops/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'boss', password: OPS_PASSWORD }),
    });
    const tempAuth = auth(preLogout.body.token);
    await json(base, '/api/ops/auth/logout', { method: 'POST', headers: tempAuth });
    assert.equal((await json(base, '/api/ops/auth/me', { headers: tempAuth })).response.status, 401);
    // logout bumps tokenVersion — the original bootstrap token died with it too
    assert.equal((await json(base, '/api/ops/auth/me', { headers: opsAuth })).response.status, 401);
    const freshLogin = await json(base, '/api/ops/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'boss', password: OPS_PASSWORD }),
    });
    const freshAuth = auth(freshLogin.body.token);

    // ---------- audit: actions recorded, secrets absent ----------
    const audit = await json(base, '/api/ops/audit?limit=200', { headers: freshAuth });
    assert.equal(audit.response.status, 200);
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    for (const expected of [
      'ops.bootstrap', 'account.disable', 'account.enable', 'account.delete',
      'family.dissolve', 'registration.update', 'backup.create', 'backup.delete',
      'operator.create', 'operator.delete',
    ]) {
      assert.ok(actions.includes(expected), `audit missing ${expected}`);
    }
    const auditRaw = await readFile(join(dataDir, 'ops-audit.jsonl'), 'utf8');
    for (const secret of [OPS_PASSWORD, 'helper-password-9', 'password123', 'fresh-code-2', ENV_REG_CODE, OPS_TOKEN]) {
      assert.ok(!auditRaw.includes(secret), `audit leaked secret ${secret}`);
    }
  } catch (error) {
    console.error(server.logs());
    throw error;
  } finally {
    await server.cleanup();
  }
});

test('ops bootstrap is refused when OPS_BOOTSTRAP_TOKEN is unset', { timeout: 60_000 }, async () => {
  const server = await startServer(4);
  try {
    const attempt = await json(server.base, '/api/ops/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ token: '', username: 'boss', password: 'password123' }),
    });
    assert.equal(attempt.response.status, 403);
    // and login rate limiting exists on the ops surface
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await json(server.base, '/api/ops/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'ghost', password: 'wrong-password-1' }),
      });
      if (res.response.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'ops login was never rate limited');
  } catch (error) {
    console.error(server.logs());
    throw error;
  } finally {
    await server.cleanup();
  }
});

/** Plan quotas over HTTP: the gate refuses at the ceiling, warns before it, and the ops
 *  console can move an account between plans and undo a wrong refusal.
 *
 *  Counters are planted on disk rather than earned by making 30 real calls — the gate reads
 *  exactly that file (data/usage/<id>-<YYYY-MM>.json), so planting exercises the real path
 *  at test speed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auth, json, startServer, testJpeg, uploadForm } from './helpers.ts';

const OPS_TOKEN = 'ops-bootstrap-token-billing';
const OPS_PASSWORD = 'ops-password-secret-1';
const PASSWORD = 'password123';

const thisMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

test('plan quotas gate the AI routes end to end', { timeout: 120_000 }, async (t) => {
  const server = await startServer(74, { OPS_BOOTSTRAP_TOKEN: OPS_TOKEN });
  t.after(() => server.cleanup());
  const { base, dataDir } = server;

  // ---------- an account, an entry, and a first AI call that is allowed ----------
  const boot = await json(base, '/api/v1/auth/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: PASSWORD, displayName: 'owner' }),
  });
  assert.equal(boot.response.status, 200);
  const header = auth(boot.body.accessToken);
  const accountId: string = boot.body.user.id;
  assert.equal(boot.body.user.plan, 'free', 'a new account starts on the free plan');

  const entryId = crypto.randomUUID();
  const upload = await fetch(`${base}/api/v1/entries`, {
    method: 'POST',
    headers: header,
    body: uploadForm(entryId),
  });
  assert.equal(upload.status, 201);

  const analyze = (): Promise<Response> =>
    fetch(`${base}/api/v1/entries/${entryId}/analyze`, {
      method: 'POST',
      headers: { ...header, 'content-type': 'application/json' },
      body: '{}',
    });

  const first = await analyze();
  assert.equal(first.status, 200, 'a fresh free account may call');
  assert.equal(first.headers.get('x-usage-warning'), null, 'no warning at zero usage');

  // ---------- plant counters just past the warning threshold ----------
  const usageDir = join(dataDir, 'usage');
  const usageFile = join(usageDir, `${accountId}-${thisMonth()}.json`);
  const plant = async (calls: number, tokens: number): Promise<void> => {
    await mkdir(usageDir, { recursive: true });
    await writeFile(
      usageFile,
      JSON.stringify({
        accountId,
        yearMonth: thisMonth(),
        calls,
        promptTokens: tokens,
        completionTokens: 0,
        estimatedCalls: 0,
        updatedAt: Date.now(),
      }),
    );
  };

  await plant(26, 0); // 26/30 = 86% of the free call quota
  const warned = await analyze();
  assert.equal(warned.status, 200, 'still allowed below the ceiling');
  const pct = Number(warned.headers.get('x-usage-warning'));
  assert.ok(pct >= 80 && pct <= 100, `expected a percentage in the warn band, got ${pct}`);

  // ---------- at the ceiling the gate refuses, with a code clients can distinguish ----------
  await plant(30, 0);
  const refused = await analyze();
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, 'QUOTA_EXCEEDED');
  assert.match(String(body.error?.message), /quota/i);

  // the token ceiling refuses independently of the call ceiling
  await plant(1, 100_000);
  const tokenRefused = await analyze();
  assert.equal(tokenRefused.status, 403);
  assert.equal(
    ((await tokenRefused.json()) as { error?: { code?: string } }).error?.code,
    'QUOTA_EXCEEDED',
  );

  // ---------- every metered AI route is behind the same gate ----------
  await plant(30, 0);
  const chat = await fetch(`${base}/api/v1/entries/${entryId}/chat`, {
    method: 'POST',
    headers: { ...header, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 403, 'chat is metered');
  const diary = await fetch(`${base}/api/v1/entries/${entryId}/diary`, {
    method: 'POST',
    headers: { ...header, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(diary.status, 403, 'diary is metered');
  const monthly = await fetch(`${base}/api/v1/monthly/${thisMonth()}/generate`, {
    method: 'POST',
    headers: { ...header, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(monthly.status, 403, 'monthly review is metered');

  // ---------- reading and writing entries is never metered ----------
  const list = await fetch(`${base}/api/v1/entries`, { headers: header });
  assert.equal(list.status, 200, 'the library stays readable at the ceiling');
  const secondEntry = await fetch(`${base}/api/v1/entries`, {
    method: 'POST',
    headers: header,
    // distinct bytes: identical ones would 409 on the per-owner dedup, not the quota
    body: uploadForm(crypto.randomUUID(), Date.now(), { image: testJpeg(7), thumb: testJpeg(7) }),
  });
  assert.equal(secondEntry.status, 201, 'importing photos stays possible at the ceiling');

  // ---------- the annual book is a plan feature, refused as FORBIDDEN not QUOTA ----------
  const annualOnFree = await fetch(`${base}/api/v1/exports/annual`, {
    method: 'POST',
    headers: { ...header, 'content-type': 'application/json' },
    body: JSON.stringify({ year: new Date().getFullYear() }),
  });
  assert.equal(annualOnFree.status, 403);
  assert.equal(
    ((await annualOnFree.json()) as { error?: { code?: string } }).error?.code,
    'FORBIDDEN',
    'a missing feature is not a spent quota',
  );

  // ---------- ops: move the account onto an unmetered plan ----------
  const opsBoot = await json(base, '/api/ops/auth/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ token: OPS_TOKEN, username: 'boss', password: OPS_PASSWORD }),
  });
  assert.equal(opsBoot.response.status, 201);
  const opsHeader = auth(opsBoot.body.token);

  const listed = await json(base, '/api/ops/accounts', { headers: opsHeader });
  const row = listed.body.items.find((a: { id: string }) => a.id === accountId);
  assert.equal(row.planStatus.plan, 'free');
  assert.equal(row.planStatus.usage.calls, 30, 'the console reports the counters the gate reads');
  assert.equal(row.planStatus.used, 1, 'a spent quota reads as 100%');

  const badPlan = await json(base, `/api/ops/accounts/${accountId}`, {
    method: 'PATCH',
    headers: opsHeader,
    body: JSON.stringify({ plan: 'enterprise' }),
  });
  assert.equal(badPlan.response.status, 400, 'plans outside the enum are rejected');

  const upgraded = await json(base, `/api/ops/accounts/${accountId}`, {
    method: 'PATCH',
    headers: opsHeader,
    body: JSON.stringify({ plan: 'family' }),
  });
  assert.equal(upgraded.response.status, 200);
  assert.equal(upgraded.body.user.plan, 'family');

  const afterUpgrade = await analyze();
  assert.equal(afterUpgrade.status, 200, 'an unmetered plan ignores the planted counters');
  assert.equal(afterUpgrade.headers.get('x-usage-warning'), null, 'unmetered plans never warn');

  const annualOnFamily = await fetch(`${base}/api/v1/exports/annual`, {
    method: 'POST',
    headers: { ...header, 'content-type': 'application/json' },
    body: JSON.stringify({ year: 1999 }),
  });
  assert.notEqual(annualOnFamily.status, 403, 'the feature gate is open on family');

  // ---------- ops: undo a refusal by clearing the month ----------
  const downgraded = await json(base, `/api/ops/accounts/${accountId}`, {
    method: 'PATCH',
    headers: opsHeader,
    body: JSON.stringify({ plan: 'free' }),
  });
  assert.equal(downgraded.response.status, 200);
  assert.equal((await analyze()).status, 403, 'back under the free ceiling');

  const badMonth = await json(base, `/api/ops/usage/${accountId}/nope`, {
    method: 'DELETE',
    headers: opsHeader,
  });
  assert.equal(badMonth.response.status, 400);

  const cleared = await json(base, `/api/ops/usage/${accountId}/${thisMonth()}`, {
    method: 'DELETE',
    headers: opsHeader,
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.existed, true);
  assert.equal((await analyze()).status, 200, 'the account may spend again');

  // ---------- both writes are auditable, and neither leaks a secret ----------
  const auditTail = await readFile(join(dataDir, 'ops-audit.jsonl'), 'utf8');
  assert.match(auditTail, /account\.plan/);
  assert.match(auditTail, /usage\.reset/);
  assert.ok(!auditTail.includes(OPS_PASSWORD), 'the audit log never carries a password');

  // ---------- the deployment reports its own authorization ----------
  const lic = await json(base, '/api/ops/license', { headers: opsHeader });
  assert.equal(lic.response.status, 200);
  // the harness runs without a token, so this asserts the demo-mode branch is honest
  assert.equal(lic.body.licensed, false);
  assert.equal(lic.body.demoMode, true);
  assert.deepEqual(lic.body.plans, ['free', 'standard', 'family'], 'no token grants everything');
  assert.equal(lic.body.seats, null, 'no token means no seat cap');
  assert.equal(typeof lic.body.accounts, 'number');
  assert.ok(lic.body.quotas.free && lic.body.quotas.family, 'quota table is reported');
});

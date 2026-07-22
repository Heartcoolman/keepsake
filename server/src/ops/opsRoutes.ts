/** /api/ops — operator console API. Operators are not user accounts: separate
 *  records, a separate token domain, and no key material — every response here
 *  is structural metadata, never user content. */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as store from '../store.ts';
import * as usage from '../usage.ts';
import * as keyring from '../keyring.ts';
import * as ops from './opsAccounts.ts';
import { clearAnalyzeCaches } from '../analyzeCache.ts';
import { clearDepthCaches } from '../depth.ts';
import { isMigrationPending } from '../deferredTasks.ts';
import { err } from '../v1/errors.ts';
import { ipRateLimit } from '../v1/middleware.ts';
import { audit, readAuditTail } from './audit.ts';
import { getRegistrationPolicy, setRegistrationPolicy } from './opsConfig.ts';
import { dissolveFamily, purgeAccountData } from './purge.ts';
import { createBackup, deleteBackup, getSystemSnapshot, listBackups } from './systemInfo.ts';

type OpsEnv = { Variables: { operator: ops.OpsAccount } };

export const opsRoutes = new Hono<OpsEnv>();

const opsBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
});

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function statusError(c: Context, e: unknown) {
  const status = Number((e as { status?: unknown }).status);
  if (status === 400) return err(c, 'VALIDATION', (e as Error).message);
  if (status === 409) return err(c, 'CONFLICT', (e as Error).message);
  throw e;
}

const requireOps: MiddlewareHandler<OpsEnv> = async (c, next) => {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m?.[1]) return err(c, 'UNAUTHORIZED', 'missing bearer token');
  const operator = await ops.resolveOpsToken(m[1].trim());
  if (!operator) return err(c, 'UNAUTHORIZED', 'invalid or expired token');
  c.set('operator', operator);
  await next();
};

// ---------- auth (the only routes reachable without an ops token) ----------

opsRoutes.post('/auth/bootstrap', ipRateLimit(5), opsBodyLimit, async (c) => {
  const expected = process.env.OPS_BOOTSTRAP_TOKEN?.trim();
  if (!expected) return err(c, 'FORBIDDEN', 'OPS_BOOTSTRAP_TOKEN is not configured');
  if ((await ops.countOpsAccounts()) > 0)
    return err(c, 'CONFLICT', 'ops console already bootstrapped');
  const body = await c.req
    .json<{ token?: unknown; username?: unknown; password?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  const token = typeof body.token === 'string' ? body.token : '';
  if (!safeEqual(token, expected)) return err(c, 'UNAUTHORIZED', 'invalid bootstrap token');
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  try {
    const operator = await ops.createOpsAccount({ username, password });
    audit(operator, 'ops.bootstrap', operator.username);
    return c.json({ ...ops.issueOpsToken(operator), operator: ops.toPublic(operator) }, 201);
  } catch (e) {
    return statusError(c, e);
  }
});

opsRoutes.post('/auth/login', ipRateLimit(10), opsBodyLimit, async (c) => {
  const body = await c.req
    .json<{ username?: unknown; password?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return err(c, 'VALIDATION', 'username and password required');
  const operator = await ops.findOpsByUsername(username);
  // Constant-cost verify against a dummy hash on misses (username enumeration).
  const stored = operator ? operator.passwordHash : await accounts.dummyPasswordHash();
  const passwordOk = await accounts.verifyPassword(password, stored);
  if (!operator || !passwordOk) return err(c, 'UNAUTHORIZED', 'invalid credentials');
  return c.json({ ...ops.issueOpsToken(operator), operator: ops.toPublic(operator) });
});

opsRoutes.use('*', requireOps);

opsRoutes.post('/auth/logout', async (c) => {
  const operator = c.get('operator');
  await ops.bumpOpsTokenVersion(operator.id);
  return c.json({ ok: true });
});

opsRoutes.get('/auth/me', (c) => c.json({ operator: ops.toPublic(c.get('operator')) }));

// ---------- operators ----------

opsRoutes.get('/operators', async (c) =>
  c.json({ items: (await ops.listOpsAccounts()).map(ops.toPublic) }),
);

opsRoutes.post('/operators', opsBodyLimit, async (c) => {
  const body = await c.req
    .json<{ username?: unknown; password?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  try {
    const created = await ops.createOpsAccount({
      username: typeof body.username === 'string' ? body.username.trim() : '',
      password: typeof body.password === 'string' ? body.password : '',
    });
    audit(c.get('operator'), 'operator.create', created.username);
    return c.json({ operator: ops.toPublic(created) }, 201);
  } catch (e) {
    return statusError(c, e);
  }
});

opsRoutes.delete('/operators/:id', async (c) => {
  const target = await ops.getOpsAccount(c.req.param('id'));
  if (!target) return err(c, 'NOT_FOUND', 'operator not found');
  const remaining = (await ops.countOpsAccounts()) - 1;
  await ops.deleteOpsAccount(target.id);
  audit(c.get('operator'), 'operator.delete', target.username);
  // remaining === 0 → console locked until the deployer re-runs the bootstrap
  return c.json({ ok: true, remaining });
});

opsRoutes.patch('/operators/:id/password', opsBodyLimit, async (c) => {
  const body = await c.req
    .json<{ password?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  try {
    const updated = await ops.setOpsPassword(
      c.req.param('id'),
      typeof body.password === 'string' ? body.password : '',
    );
    if (!updated) return err(c, 'NOT_FOUND', 'operator not found');
    audit(c.get('operator'), 'operator.password', updated.username);
    return c.json({ ok: true });
  } catch (e) {
    return statusError(c, e);
  }
});

// ---------- user accounts (structural only; no reads of content, no password reset) ----------

opsRoutes.get('/accounts', async (c) => {
  const list = await accounts.listAccounts();
  const entryCounts = new Map<string, number>();
  for (const entry of await store.listEntries()) {
    const owner = entry.ownerId || entry.userId;
    if (owner) entryCounts.set(owner, (entryCounts.get(owner) ?? 0) + 1);
  }
  const familyNames = new Map((await families.listFamilies()).map((f) => [f.id, f.name]));
  const items = [];
  for (const account of list) {
    items.push({
      ...accounts.toPublic(account),
      familyName: account.familyId ? familyNames.get(account.familyId) ?? '' : '',
      hasCrypto: accounts.hasCrypto(account),
      unlocked: !!keyring.getUdk(account.id),
      entryCount: entryCounts.get(account.id) ?? 0,
      storageBytes: await store.ownerStorageBytes(account.id),
      migrationPending: await isMigrationPending(account.id),
    });
  }
  return c.json({ items });
});

opsRoutes.patch('/accounts/:id', opsBodyLimit, async (c) => {
  const body = await c.req
    .json<{ disabled?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  if (typeof body.disabled !== 'boolean')
    return err(c, 'VALIDATION', 'disabled (boolean) required');
  const disabled = body.disabled;
  const target = await accounts.getAccount(c.req.param('id'));
  if (!target) return err(c, 'NOT_FOUND', 'account not found');
  const updated = await accounts.updateAccount(target.id, (cur) => ({
    ...cur,
    disabled,
    // disabling kills every outstanding token; re-enabling forces a fresh login anyway
    ...(disabled ? { tokenVersion: cur.tokenVersion + 1, refreshJti: null } : {}),
    updatedAt: Date.now(),
  }));
  if (disabled) keyring.wipe(target.id);
  audit(c.get('operator'), disabled ? 'account.disable' : 'account.enable', target.username);
  return c.json({ user: accounts.toPublic(updated ?? target) });
});

opsRoutes.delete('/accounts/:id', async (c) => {
  const target = await accounts.getAccount(c.req.param('id'));
  if (!target) return err(c, 'NOT_FOUND', 'account not found');
  if (target.familyId)
    return err(
      c,
      'CONFLICT',
      'account belongs to a family — have the owner remove it, or dissolve the family first',
    );
  await purgeAccountData(target);
  audit(c.get('operator'), 'account.delete', target.username);
  return c.json({ ok: true });
});

// ---------- families ----------

opsRoutes.get('/families', async (c) => {
  const items = [];
  for (const family of await families.listFamilies()) {
    items.push({
      id: family.id,
      name: family.name,
      ownerId: family.ownerId,
      createdAt: family.createdAt,
      members: (await accounts.listAccounts(family.id)).map((a) => ({
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        accountType: a.accountType,
      })),
      pendingInvites: (await families.listInvitesForFamily(family.id)).length,
    });
  }
  return c.json({ items });
});

opsRoutes.delete('/families/:id', async (c) => {
  const family = await families.getFamily(c.req.param('id'));
  if (!family) return err(c, 'NOT_FOUND', 'family not found');
  const result = await dissolveFamily(family.id);
  audit(c.get('operator'), 'family.dissolve', family.name, `${result.members} member(s) detached`);
  return c.json({ ok: true, ...result });
});

// ---------- usage ----------

opsRoutes.get('/usage', async (c) => {
  const month = c.req.query('month');
  const all = await usage.listUsage();
  if (month) {
    if (!store.validYearMonth(month)) return err(c, 'VALIDATION', 'month must be YYYY-MM');
    const names = new Map(
      (await accounts.listAccounts()).map((a) => [a.id, a.username] as const),
    );
    const items = all
      .filter((u) => u.yearMonth === month)
      .map((u) => ({ ...u, username: names.get(u.accountId) ?? '(deleted)' }))
      .sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
    return c.json({ month, items });
  }
  const byMonth = new Map<
    string,
    { yearMonth: string; calls: number; promptTokens: number; completionTokens: number; accounts: number }
  >();
  for (const u of all) {
    const agg = byMonth.get(u.yearMonth) ?? {
      yearMonth: u.yearMonth,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      accounts: 0,
    };
    agg.calls += u.calls;
    agg.promptTokens += u.promptTokens;
    agg.completionTokens += u.completionTokens;
    agg.accounts += 1;
    byMonth.set(u.yearMonth, agg);
  }
  return c.json({
    months: [...byMonth.values()].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth)),
  });
});

// ---------- system ----------

opsRoutes.get('/system', async (c) =>
  c.json(await getSystemSnapshot(c.req.query('refresh') === '1')),
);

opsRoutes.post('/system/cache/clear', opsBodyLimit, async (c) => {
  const body = await c.req.json<{ kind?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const kind = body.kind;
  // face/faceThumb caches are deliberately NOT clearable: dropping them without
  // resetting faceScannedAt breaks clustering, and a rescan needs owner logins.
  if (kind !== 'depth' && kind !== 'analyze')
    return err(c, 'VALIDATION', "kind must be 'depth' or 'analyze'");
  const removed = kind === 'depth' ? await clearDepthCaches() : await clearAnalyzeCaches();
  audit(c.get('operator'), 'cache.clear', kind, `${removed} file(s)`);
  return c.json({ removed });
});

// ---------- backups ----------

opsRoutes.get('/backups', async (c) => c.json({ items: await listBackups() }));

opsRoutes.post('/backups', async (c) => {
  const backup = await createBackup();
  audit(c.get('operator'), 'backup.create', backup.name, `${backup.bytes} bytes`);
  return c.json(backup, 201);
});

opsRoutes.delete('/backups/:name', async (c) => {
  const name = c.req.param('name');
  if (!(await deleteBackup(name))) return err(c, 'NOT_FOUND', 'backup not found');
  audit(c.get('operator'), 'backup.delete', name);
  return c.json({ ok: true });
});

// ---------- registration policy ----------

opsRoutes.get('/registration', async (c) => {
  const policy = await getRegistrationPolicy();
  // the code itself is never echoed back — set it, share it out-of-band
  return c.json({ open: policy.open, codeRequired: !!policy.code, source: policy.source });
});

opsRoutes.patch('/registration', opsBodyLimit, async (c) => {
  const body = await c.req
    .json<{ open?: unknown; code?: unknown }>()
    .catch(() => ({} as Record<string, unknown>));
  const patch: { open?: boolean; code?: string | null } = {};
  if (body.open !== undefined) {
    if (typeof body.open !== 'boolean') return err(c, 'VALIDATION', 'open must be boolean');
    patch.open = body.open;
  }
  if (body.code !== undefined) {
    if (body.code !== null && typeof body.code !== 'string')
      return err(c, 'VALIDATION', 'code must be a string or null');
    patch.code = body.code;
  }
  const policy = await setRegistrationPolicy(patch);
  audit(
    c.get('operator'),
    'registration.update',
    '',
    `open=${policy.open} codeRequired=${!!policy.code}`,
  );
  return c.json({ open: policy.open, codeRequired: !!policy.code, source: policy.source });
});

// ---------- audit ----------

opsRoutes.get('/audit', async (c) => {
  const limit = Math.min(500, Math.max(1, Math.floor(Number(c.req.query('limit')) || 100)));
  return c.json({ items: await readAuditTail(limit) });
});

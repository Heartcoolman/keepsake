import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as store from './store.ts';
import * as accounts from './accounts.ts';
import { countOpsAccounts } from './ops/opsAccounts.ts';
import { opsRoutes } from './ops/opsRoutes.ts';
import { startKeyringSweep } from './keyring.ts';
import { startDeferredTasks } from './deferredTasks.ts';
import { createV1Router } from './v1/router.ts';
import { runFamilyMigration, runV1Migration } from './v1/migrate.ts';

const MOCK = process.env.MOCK_AI === '1';
const configuredPort = Number(process.env.PORT || 8787);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536
  ? configuredPort
  : 8787;

if (!MOCK && !process.env.XAI_API_KEY && !process.env.AI_BASE_URL) {
  console.error('XAI_API_KEY is not set. Fill .env, set AI_BASE_URL for a local gateway, or run with MOCK_AI=1.');
  process.exit(1);
}

try {
  accounts.assertAuthConfigured();
} catch (error) {
  console.error(`[auth] ${(error as Error).message}`);
  process.exit(1);
}

// First-boot safety: until an account exists, /api/v1/auth/bootstrap is open to
// whoever reaches the port first. Make that window impossible to miss.
if (!process.env.BOOTSTRAP_TOKEN?.trim() && (await accounts.countAccounts()) === 0) {
  console.warn(
    '[auth] WARNING: no accounts exist and BOOTSTRAP_TOKEN is not set — the first visitor to ' +
      'POST /api/v1/auth/bootstrap becomes the first family owner. If this port is reachable ' +
      'beyond localhost (LAN/tunnel), set BOOTSTRAP_TOKEN in .env before exposing it.',
  );
}

// The first operator is created via OPS_BOOTSTRAP_TOKEN — an ops account can
// disable/delete any user account, so this window must be impossible to miss.
if (process.env.OPS_BOOTSTRAP_TOKEN?.trim() && (await countOpsAccounts()) === 0) {
  console.warn(
    '[ops] WARNING: OPS_BOOTSTRAP_TOKEN is set and no operator exists yet — whoever presents ' +
      'the token at /ops becomes the first operator. Bootstrap now, then remove the token from .env.',
  );
}

const app = new Hono();

app.onError((error, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path}`, error);
  const hinted = Number((error as { status?: unknown }).status);
  const status = Number.isInteger(hinted) && hinted >= 400 && hinted < 600
    ? hinted
    : error instanceof SyntaxError
      ? 400
      : 500;
  return c.json({ error: status === 400 ? 'bad request' : 'internal error' }, status as 400 | 500);
});

// ---------- API v1: the only API surface — auth, per-owner isolation, SSE envelope.
// See docs/api-v1.md. The old unauthenticated /api/* routes have been removed.
app.route('/api/v1', createV1Router());

// Operator console API (see docs/ops.md) — must mount before the /api/* 404.
app.route('/api/ops', opsRoutes);

// Any other /api/* path is unknown — never fall through to the SPA for API calls.
app.use('/api/*', async (c) => c.json({ error: 'not found' }, 404));

// Operator console page: served by the server itself (never part of the user
// SPA bundle), registered before the SPA catch-all so it is not swallowed.
const OPS_STATIC = fileURLToPath(new URL('./ops/static/', import.meta.url));
if (existsSync(OPS_STATIC)) {
  app.get('/ops', serveStatic({ path: `${OPS_STATIC}index.html` }));
  app.get('/ops/app.js', serveStatic({ path: `${OPS_STATIC}app.js` }));
  app.get('/ops/style.css', serveStatic({ path: `${OPS_STATIC}style.css` }));
}

// ONNX warmup only: model files are not user data. Every sweep that reads user
// content is deferred until a member's keys enter the keyring (deferredTasks.ts).
if (process.env.INFERENCE_DISABLED !== '1') {
  import('./depth.ts').then((m) => m.prewarmDepth()).catch(() => {});
  import('./face.ts').then((m) => m.prewarmFace()).catch(() => {});
}

// production: serve the built client regardless of the process working directory.
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(CLIENT_DIST)) {
  app.use('/*', serveStatic({ root: CLIENT_DIST }));
  app.get('*', serveStatic({ path: `${CLIENT_DIST}/index.html` }));
}

/** Entries written before multi-user profiles had no owner. When there is
 * exactly one account, that ownership is unambiguous, so preserve the old
 * chat and diary instead of presenting every entry as new. (Structural only —
 * decidable without any keys, unlike the old isUser-person check.) */
async function adoptUnownedLegacyEntries(): Promise<void> {
  const all = await accounts.listAccounts();
  if (all.length !== 1) return;
  const userId = all[0]!.id;
  let adopted = 0;
  for (const entry of await store.listEntries()) {
    if (entry.userId) continue;
    const updated = await store.patchEntry(entry.id, { userId, ownerId: userId });
    if (updated) adopted++;
  }
  if (adopted) console.log(`[store] assigned ${adopted} legacy entries to the only account`);
}

await adoptUnownedLegacyEntries().catch((error) => {
  console.warn('[store] legacy owner migration skipped:', error);
});

await runV1Migration().catch((error) => {
  console.warn('[migrate-v1] skipped:', error);
});

await runFamilyMigration().catch((error) => {
  console.warn('[migrate-family] skipped:', error);
});

startKeyringSweep();
startDeferredTasks();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`nianxiang server on :${info.port}${MOCK ? ' (MOCK_AI)' : ''} (api v1 at /api/v1)`);
});

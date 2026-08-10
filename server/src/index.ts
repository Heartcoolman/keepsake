import { license } from './licenseBoot.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { sweepOrphanTransients } from './lib/atomicFile.ts';
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

// ---------- Security headers + method guard (defense-in-depth).
// No reverse proxy ships with the app (docker-compose exposes :8787 directly), so
// the app sets these itself rather than trusting a proxy that may not exist. Set
// after next() so the SPA catch-all and the raw-Response SSE streams are covered
// too. HSTS only bites behind a TLS terminator — deploy one (see docs/deploy-tunnel.md).
// CSP mirrors client/index.html (keep the two in sync) so the in-browser depth
// fallback (client/src/lib/depth.ts) can still fetch model weights + ORT wasm; it
// adds frame-ancestors 'none', which a <meta> cannot express — the real clickjacking fix.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.hf.co https://cdn-lfs.huggingface.co " +
    'https://cdn-lfs-us-1.huggingface.co https://hf-mirror.com https://*.hf-mirror.com https://cdn.jsdelivr.net',
  "form-action 'self'",
].join('; ');

app.use('*', async (c, next) => {
  // TRACE/TRACK are cross-site-tracing primitives no route needs.
  if (c.req.method === 'TRACE' || c.req.method === 'TRACK')
    return c.text('Method Not Allowed', 405, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' });
  await next();
  const h = c.res.headers;
  h.set('Content-Security-Policy', CSP);
  h.set('X-Frame-Options', 'DENY');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // COOP is safe (only affects cross-origin popups the SPA never opens). COEP is
  // omitted (require-corp would block the cross-origin HuggingFace depth fallback);
  // CORP is omitted too so a hybrid native shell can still load our assets/API.
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Permitted-Cross-Domain-Policies', 'none');
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
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
  // The SPA surface is read-only: only GET/HEAD/OPTIONS reach static files. Other
  // methods on a non-API path previously returned 200 from serveStatic on any
  // existing file (e.g. PUT / → index.html). /api/* already terminated above.
  app.use('/*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS')
      return c.text('Method Not Allowed', 405, { Allow: 'GET, HEAD, OPTIONS' });
    await next();
  });
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

// Remove any plaintext .bak/.tmp stranded by a crash mid atomic-write / migration
// before we start serving — nothing else reclaims them and a stray .bak can hold
// the original unencrypted row from a legacy→encrypted rewrite.
{
  const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
  const cacheRoot = fileURLToPath(new URL('../cache/', import.meta.url));
  const swept = await sweepOrphanTransients([dataRoot, cacheRoot]).catch((error) => {
    console.warn('[store] orphan-transient sweep skipped:', error);
    return 0;
  });
  if (swept) console.log(`[store] swept ${swept} orphaned .tmp/.bak file(s)`);
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
  const licensed = license ? ` [licensed to ${license.licensee}]` : ' [unlicensed demo]';
  console.log(`nianxiang server on :${info.port}${MOCK ? ' (MOCK_AI)' : ''}${licensed} (api v1 at /api/v1)`);
});

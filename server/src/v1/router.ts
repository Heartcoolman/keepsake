import { Hono } from 'hono';
import * as accounts from '../accounts.ts';
import { authRoutes } from './authRoutes.ts';
import { familyRoutes } from './familyRoutes.ts';
import { entriesRoutes } from './entriesRoutes.ts';
import { peopleRoutes } from './peopleRoutes.ts';
import { relationshipRoutes } from './relationshipRoutes.ts';
import { profileRoutes } from './profileRoutes.ts';
import { aiRoutes } from './aiRoutes.ts';
import { sessionRoutes } from './sessionRoutes.ts';
import { requireAuth, type AppEnv } from './middleware.ts';
import { err } from './errors.ts';

const MOCK = process.env.MOCK_AI === '1';
const INFERENCE_DISABLED = process.env.INFERENCE_DISABLED === '1';

export function createV1Router(): Hono<AppEnv> {
  const v1 = new Hono<AppEnv>();

  v1.onError((error, c) => {
    console.error(`[api-v1] ${c.req.method} ${c.req.path}`, error);
    const hinted = Number((error as { status?: unknown }).status);
    if (error instanceof SyntaxError) return err(c, 'VALIDATION', 'invalid JSON');
    if (hinted === 413) return err(c, 'PAYLOAD_TOO_LARGE', 'payload too large');
    if (hinted >= 400 && hinted < 500)
      return err(c, 'VALIDATION', (error as Error).message || 'bad request');
    return err(c, 'INTERNAL', 'internal error');
  });

  v1.use('*', async (c, next) => {
    c.header('X-API-Version', '1');
    await next();
  });

  // public
  v1.get('/health', async (c) => {
    const accountCount = await accounts.countAccounts();
    return c.json({
      ok: true,
      mock: MOCK,
      apiVersion: 1,
      authRequired: true,
      bootstrapped: accountCount > 0,
    });
  });

  v1.route('/', authRoutes);

  v1.get('/config', requireAuth, async (c) => {
    return c.json({
      maxUploadBytes: 20 * 1024 * 1024,
      features: {
        depth: !INFERENCE_DISABLED,
        face: !INFERENCE_DISABLED,
        mockAi: MOCK,
      },
      user: accounts.toPublic(c.get('account')),
    });
  });

  v1.route('/', familyRoutes);
  v1.route('/', entriesRoutes);
  v1.route('/', peopleRoutes);
  v1.route('/', relationshipRoutes);
  v1.route('/', profileRoutes);
  v1.route('/', sessionRoutes);
  v1.route('/', aiRoutes);

  v1.notFound((c) => err(c, 'NOT_FOUND', 'not found'));

  return v1;
}

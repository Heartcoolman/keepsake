/**
 * Session intents: open / message / complete.
 * PUBLIC STUB — the real orchestration (server as sole source of truth for opener,
 * chat, status and diary; SSE streaming; busy-locking; post-diary hooks) lives in
 * the private core module. These routes degrade honestly: same paths, same auth
 * behavior (401/423 via requireKeys), then 501 + UNAVAILABLE.
 */
import { Hono } from 'hono';
import { err } from './errors.ts';
import { requireKeys, type AppEnv } from './middleware.ts';

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.use('*', requireKeys);

const unavailable = (c: Parameters<typeof err>[0]) =>
  err(c, 'UNAVAILABLE', 'session orchestration is part of the private core module — not available in this build', 501);

sessionRoutes.post('/entries/:id/session/open', (c) => unavailable(c));
sessionRoutes.post('/entries/:id/session/message', (c) => unavailable(c));
sessionRoutes.post('/entries/:id/session/complete', (c) => unavailable(c));

import { Hono } from 'hono';
import * as memory from '../memory.ts';
import * as keyring from '../keyring.ts';
import { err } from './errors.ts';
import { requireKeys, type AppEnv } from './middleware.ts';

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.use('*', requireKeys);

profileRoutes.get('/me/profile', async (c) => {
  const id = c.get('account').id;
  return c.json(await memory.getUserData(id, keyring.getUdk(id)!));
});

profileRoutes.patch('/me/profile', async (c) => {
  const id = c.get('account').id;
  const { personality } = await c.req.json<{ personality?: unknown }>();
  if (typeof personality !== 'string') return err(c, 'VALIDATION', 'personality required');
  return c.json(await memory.editPersonality(id, keyring.getUdk(id)!, personality.slice(0, 500)));
});

profileRoutes.patch('/me/memories/:memId', async (c) => {
  const id = c.get('account').id;
  const { text } = await c.req.json<{ text?: unknown }>();
  if (typeof text !== 'string' || !text.trim()) return err(c, 'VALIDATION', 'text required');
  return c.json(
    await memory.editMemory(id, keyring.getUdk(id)!, c.req.param('memId'), text.trim().slice(0, 120)),
  );
});

profileRoutes.delete('/me/memories/:memId', async (c) => {
  const id = c.get('account').id;
  return c.json(await memory.deleteMemory(id, keyring.getUdk(id)!, c.req.param('memId')));
});

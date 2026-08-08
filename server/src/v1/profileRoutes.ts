import { Hono } from 'hono';
import * as memory from '../memory.ts';
import * as keyring from '../keyring.ts';
import { err } from './errors.ts';
import { requireKeys, type AppEnv } from './middleware.ts';

export const profileRoutes = new Hono<AppEnv>();

profileRoutes.use('*', requireKeys);

/** Strip C0 control chars + DEL (keep tab/newline/CR) from user-supplied text.
 *  Defense-in-depth: React already escapes on render, but stored fields should not
 *  carry control characters that can corrupt logs or other consumers. */
function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

profileRoutes.get('/me/profile', async (c) => {
  const id = c.get('account').id;
  return c.json(await memory.getUserData(id, keyring.getUdk(id)!));
});

profileRoutes.patch('/me/profile', async (c) => {
  const id = c.get('account').id;
  const { personality } = await c.req.json<{ personality?: unknown }>();
  if (typeof personality !== 'string') return err(c, 'VALIDATION', 'personality required');
  return c.json(await memory.editPersonality(id, keyring.getUdk(id)!, cleanText(personality).slice(0, 500)));
});

profileRoutes.patch('/me/memories/:memId', async (c) => {
  const id = c.get('account').id;
  const udk = keyring.getUdk(id)!;
  const { text } = await c.req.json<{ text?: unknown }>();
  if (typeof text !== 'string' || !text.trim()) return err(c, 'VALIDATION', 'text required');
  const memId = c.req.param('memId');
  // 404 on an unknown id instead of a silent 200 no-op — the existence check also
  // avoids the encrypt+fsync write updateUserData would otherwise do on a miss.
  const data = await memory.getUserData(id, udk);
  if (!data.memories.some((m) => m.id === memId)) return err(c, 'NOT_FOUND', 'memory not found');
  return c.json(await memory.editMemory(id, udk, memId, cleanText(text).trim().slice(0, 120)));
});

profileRoutes.delete('/me/memories/:memId', async (c) => {
  const id = c.get('account').id;
  const udk = keyring.getUdk(id)!;
  const memId = c.req.param('memId');
  const data = await memory.getUserData(id, udk);
  if (!data.memories.some((m) => m.id === memId)) return err(c, 'NOT_FOUND', 'memory not found');
  return c.json(await memory.deleteMemory(id, udk, memId));
});

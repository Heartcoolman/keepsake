import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as store from '../store.ts';
import * as keyring from '../keyring.ts';
import * as accounts from '../accounts.ts';
import { enqueueInference } from '../inferenceQueue.ts';
import { err } from './errors.ts';
import { requireKeys, type AppEnv } from './middleware.ts';

export const entriesRoutes = new Hono<AppEnv>();

entriesRoutes.use('*', requireKeys);

function notOwned() {
  // intentional 404 — do not leak existence across users
  return { code: 'NOT_FOUND' as const, message: 'entry not found' };
}

type Ctx = { get: (k: 'account') => accounts.Account; req: { param(n: string): string } };

/** udk is present behind requireKeys. */
function udkOf(c: Ctx): Buffer {
  return keyring.getUdk(c.get('account').id)!;
}

/** Scope key for face features — undefined when a member's FK grant is missing. */
function scopeKeyOf(c: Ctx): { scopeId: string; scopeKey: Buffer | undefined } {
  const scopeId = accounts.scopeIdOf(c.get('account'));
  return { scopeId, scopeKey: keyring.getScopeKey(scopeId) };
}

async function loadOwned(
  c: Ctx,
): Promise<{ ok: true; entry: store.EntryMeta } | { ok: false }> {
  const id = c.req.param('id');
  if (!store.validId(id)) return { ok: false };
  const entry = await store.getEntry(id);
  if (!store.isOwnedBy(entry, c.get('account').id)) return { ok: false };
  return { ok: true, entry };
}

entriesRoutes.get('/entries', async (c) => {
  const ownerId = c.get('account').id;
  const status = c.req.query('status');
  const yearMonth = c.req.query('yearMonth') ?? undefined;
  const cursor = c.req.query('cursor') ?? undefined;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  if (status && status !== 'new' && status !== 'chatting' && status !== 'done')
    return err(c, 'VALIDATION', 'bad status');
  if (yearMonth && !store.validYearMonth(yearMonth)) return err(c, 'VALIDATION', 'bad yearMonth');
  const page = await store.listEntriesPage(
    {
      ownerId,
      status: status as store.EntryMeta['status'] | undefined,
      yearMonth,
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    },
    udkOf(c),
  );
  return c.json(page);
});

entriesRoutes.get('/entries/:id', async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  const full = await store.getEntryDecrypted(loaded.entry.id, udkOf(c));
  return c.json(full ?? loaded.entry);
});

entriesRoutes.post('/entries', bodyLimit({
  maxSize: 21 * 1024 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'upload too large'),
}), async (c) => {
  const form = await c.req.formData();
  const metaRaw = form.get('meta');
  const image = form.get('image');
  const thumb = form.get('thumb');
  if (typeof metaRaw !== 'string' || !(image instanceof File) || !(thumb instanceof File))
    return err(c, 'VALIDATION', 'meta, image and thumb are required');
  if (!image.size || !thumb.size || image.size + thumb.size > 20 * 1024 * 1024)
    return err(c, 'PAYLOAD_TOO_LARGE', 'image and thumb exceed upload limit');
  if (image.type !== 'image/jpeg' || thumb.type !== 'image/jpeg')
    return err(c, 'VALIDATION', 'image and thumb must be JPEG');
  let meta: store.EntryMeta;
  try {
    meta = store.sanitizeMeta(JSON.parse(metaRaw) as Record<string, unknown>);
  } catch {
    return err(c, 'VALIDATION', 'meta must be JSON');
  }
  if (!store.validId(meta.id)) return err(c, 'VALIDATION', 'bad id');
  // force ownership + tenancy from the authenticated account
  const account = c.get('account');
  const ownerId = account.id;
  meta = store.sanitizeMeta({
    ...meta,
    ownerId,
    userId: ownerId,
    familyId: account.familyId,
  } as unknown as Record<string, unknown>);
  const imageBuf = Buffer.from(await image.arrayBuffer());
  const thumbBuf = Buffer.from(await thumb.arrayBuffer());
  const isJpeg = (buf: Buffer) =>
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isJpeg(imageBuf) || !isJpeg(thumbBuf))
    return err(c, 'VALIDATION', 'invalid JPEG data');
  const udk = udkOf(c);
  const created = await store.putEntry(meta, imageBuf, thumbBuf, udk);
  if (!created) return err(c, 'CONFLICT', 'entry id already exists');

  if (process.env.INFERENCE_DISABLED !== '1') {
    void enqueueInference(
      async () => (await import('../depth.ts')).computeDepth(imageBuf, ownerId, udk),
      { priority: 'batch' },
    ).catch(() => {});
    const { scopeId, scopeKey } = scopeKeyOf(c);
    if (scopeKey) {
      void (async () => {
        try {
          const face = await import('../face.ts');
          await enqueueInference(() => face.scanEntry(meta.id, imageBuf, scopeId, scopeKey), {
            priority: 'batch',
          });
        } catch {
          /* prewarm best-effort */
        }
      })();
    }
  }

  const stored = await store.getEntryDecrypted(meta.id, udk);
  return c.json(stored ?? meta, 201);
});

/** User-editable fields only. Session-owned chat/status/imageDescription go via session API.
 *  yearMonth is intentionally absent: sanitizeMeta always derives it from takenAt,
 *  so accepting it would be a silent no-op. */
const PATCH_ALLOW = new Set([
  'title',
  'diaryText',
  'mood',
  'takenAt',
  'createdAt',
  'dateSource',
]);

entriesRoutes.patch('/entries/:id', bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
}), async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  const body = (await c.req.json()) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.length) return err(c, 'VALIDATION', 'empty patch');
  const illegal = keys.filter((k) => !PATCH_ALLOW.has(k));
  if (illegal.length)
    return err(c, 'VALIDATION', `fields not allowed: ${illegal.join(', ')}`);
  // sanitizeMeta reads takenAt first and forces createdAt = takenAt, so a
  // createdAt-only patch is otherwise dropped; mirror it onto takenAt to apply.
  if ('createdAt' in body && !('takenAt' in body)) body.takenAt = body.createdAt;
  const next = await store.patchEntryContent(loaded.entry.id, body, udkOf(c));
  return next ? c.json(next) : err(c, 'NOT_FOUND', notOwned().message);
});

entriesRoutes.delete('/entries/:id', async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  const ok = await store.deleteEntry(loaded.entry.id);
  return ok ? c.json({ ok: true }) : err(c, 'NOT_FOUND', notOwned().message);
});

entriesRoutes.get('/entries/:id/media/:kind{(image|thumb)}', async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  const kind = c.req.param('kind') === 'image' ? 'img' : 'thumb';
  const buf = await store.readEntryBlob(loaded.entry.id, kind, udkOf(c));
  if (!buf) return err(c, 'NOT_FOUND', 'media not found');
  return c.body(new Uint8Array(buf), 200, {
    'content-type': 'image/jpeg',
    'cache-control': 'private, max-age=31536000, immutable',
  });
});

entriesRoutes.get('/entries/:id/depth', async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  if (process.env.INFERENCE_DISABLED === '1') return err(c, 'UNAVAILABLE', 'depth unavailable');
  const udk = udkOf(c);
  const ownerId = c.get('account').id;
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  try {
    const depth = await import('../depth.ts');
    // Cache hit needs neither the decrypted photo nor the inference queue.
    const cached = await depth.readDepthCache(ownerId, loaded.entry.imageHash, udk);
    if (cached) return c.body(cached, 200, headers);
    const img = await store.readEntryBlob(loaded.entry.id, 'img', udk);
    if (!img) return err(c, 'NOT_FOUND', 'media not found');
    return c.body(await enqueueInference(() => depth.computeDepth(img, ownerId, udk)), 200, headers);
  } catch (e) {
    console.error('[v1] depth failed', e);
    return err(c, 'UNAVAILABLE', 'depth unavailable');
  }
});

entriesRoutes.get('/entries/:id/faces', async (c) => {
  const loaded = await loadOwned(c);
  if (!loaded.ok) return err(c, 'NOT_FOUND', notOwned().message);
  return c.json({
    people: loaded.entry.people,
    unknownFaces: loaded.entry.unknownFaces,
    faceScannedAt: loaded.entry.faceScannedAt,
  });
});

/** The people library is scope-shared, so a face crop that has been enrolled to a
 *  person is visible to any member of the same scope — otherwise shared people would
 *  render blank avatars for everyone except the photo's owner. Un-enrolled faces
 *  stay owner-only. */
async function faceIsEnrolledToSharedPerson(
  entryId: string,
  faceIndex: number,
  scopeId: string,
  scopeKey: Buffer,
): Promise<boolean> {
  const people = await import('../people.ts');
  return (await people.listPeople(scopeId, scopeKey)).some((p) =>
    p.enrolledFrom.some((s) => s.entryId === entryId && s.faceIndex === faceIndex),
  );
}

entriesRoutes.get('/entries/:id/faces/:idx/thumb', async (c) => {
  const id = c.req.param('id');
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx >= 20) return err(c, 'VALIDATION', 'bad face index');
  const { scopeId, scopeKey } = scopeKeyOf(c);
  if (!scopeKey) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const loaded = await loadOwned(c);
  if (!loaded.ok) {
    // not the owner: visible only when the face is enrolled + same scope
    const entry = store.validId(id) ? await store.getEntry(id) : undefined;
    const sameScope = !!entry && store.entryScopeId(entry) === scopeId;
    const shared = sameScope && (await faceIsEnrolledToSharedPerson(id, idx, scopeId, scopeKey));
    if (!shared) return err(c, 'NOT_FOUND', notOwned().message);
  }
  if (process.env.INFERENCE_DISABLED === '1') return err(c, 'UNAVAILABLE', 'face unavailable');
  try {
    const face = await import('../face.ts');
    // owner's UDK only available when the caller owns the photo
    const ownerUdk = loaded.ok ? udkOf(c) : undefined;
    // Cache hits skip the queue; a miss runs ONNX detection, so it goes through
    // the shared gate like every other inference path.
    const buf =
      (await face.readFaceThumbCache(id, idx, scopeId, scopeKey)) ??
      (await enqueueInference(() => face.faceThumb(id, idx, scopeId, scopeKey, ownerUdk)));
    if (!buf) return err(c, 'NOT_FOUND', 'face thumb not found');
    return c.body(new Uint8Array(buf), 200, {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=31536000, immutable',
    });
  } catch (e) {
    console.error('[v1] face thumb failed', e);
    return err(c, 'UNAVAILABLE', 'face unavailable');
  }
});

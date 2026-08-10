/** Memory exports: share card (single entry → JPEG) and annual book (year → PDF).
 *
 *  Both serve decrypted content, so the whole group sits behind requireKeys, and both
 *  stream straight out of RAM — no plaintext export ever touches disk. Foreign entry
 *  ids 404 like everywhere else (no existence leak). Fonts download on first use (or
 *  via scripts/fetch-fonts.sh); until they land these routes 503 and nothing else is
 *  affected. */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as store from '../store.ts';
import * as keyring from '../keyring.ts';
import * as accounts from '../accounts.ts';
import * as people from '../people.ts';
import * as annual from '../annual.ts';
import { fontsReady, renderCard } from '../exports/render.ts';
import { err } from './errors.ts';
import { requireKeys, requireAiEntitlement, userRateLimit, type AppEnv } from './middleware.ts';
import { SSE_HEADERS, v1Frame } from './sse.ts';

export const exportsRoutes = new Hono<AppEnv>();

exportsRoutes.use('*', requireKeys);

const annualBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
});

exportsRoutes.get('/exports/card/:id', userRateLimit(30), async (c) => {
  if (!(await fontsReady())) return err(c, 'UNAVAILABLE', 'export fonts missing');
  const id = c.req.param('id');
  const account = c.get('account');
  if (!store.validId(id)) return err(c, 'NOT_FOUND', 'entry not found');
  const meta = await store.getEntry(id);
  if (!store.isOwnedBy(meta, account.id)) return err(c, 'NOT_FOUND', 'entry not found');
  const udk = keyring.getUdk(account.id)!;
  const entry = await store.getEntryDecrypted(id, udk);
  if (!entry) return err(c, 'NOT_FOUND', 'entry not found');
  const photo = await store.readEntryBlob(id, 'img', udk);
  if (!photo) return err(c, 'NOT_FOUND', 'media not found');

  // people names are scope-shared and optional — a member without an FK grant
  // simply gets a card without the names line
  let peopleLabel = '';
  const scopeKey = keyring.getScopeKey(accounts.scopeIdOf(account));
  if (scopeKey && entry.people.length) {
    try {
      const names = new Map(
        (await people.listPeople(accounts.scopeIdOf(account), scopeKey)).map((p) => [p.id, p.name]),
      );
      const resolved = entry.people.map((r) => names.get(r.personId)).filter(Boolean) as string[];
      if (resolved.length)
        peopleLabel =
          resolved.slice(0, 4).join(' · ') + (resolved.length > 4 ? ` 等 ${resolved.length} 人` : '');
    } catch {
      /* names are decoration — never fail the card over them */
    }
  }

  try {
    const jpeg = await renderCard({
      photo,
      title: entry.title,
      // diary only — imageDescription is the internal photo analysis written for the
      // model, never for anyone to read, let alone to share
      body: entry.diaryText || '',
      dateLabel: annual.ymdCn(entry.takenAt),
      peopleLabel,
    });
    return c.body(new Uint8Array(jpeg), 200, {
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="keepsake-card-${id.slice(0, 8)}.jpg"`,
    });
  } catch (e) {
    console.error('[v1] card render failed', e);
    return err(c, 'INTERNAL', 'card render failed');
  }
});

/** POST { year } → SSE progress stream while the book renders; the finished PDF is
 *  parked in RAM for a short window and fetched via GET /exports/annual/:year/file. */
exportsRoutes.post('/exports/annual', annualBodyLimit, userRateLimit(4), requireAiEntitlement, async (c) => {
  if (!(await fontsReady())) return err(c, 'UNAVAILABLE', 'export fonts missing');
  let year: number;
  try {
    const body = (await c.req.json()) as { year?: unknown };
    year = Number(body.year);
  } catch {
    return err(c, 'VALIDATION', 'invalid JSON');
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2099)
    return err(c, 'VALIDATION', 'bad year');

  const account = c.get('account');
  const source: annual.AnnualSource = {
    accountId: account.id,
    displayName: account.displayName || account.username,
    scopeId: accounts.scopeIdOf(account),
    udk: keyring.getUdk(account.id)!,
    scopeKey: keyring.getScopeKey(accounts.scopeIdOf(account)),
    year,
  };
  // cheap pre-checks answer as plain errors, not a stream that dies immediately
  if (!(await annual.yearEntries(source)).length)
    return err(c, 'VALIDATION', 'no entries this year');
  if (!annual.startJob(account.id, year)) return err(c, 'CONFLICT', 'already generating');

  const signal = c.req.raw.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(v1Frame(obj));
        } catch {
          /* stream already closed */
        }
      };
      void (async () => {
        try {
          const result = await annual.generateAnnual(source, signal, (p) =>
            send({ type: 'progress', step: p.step, total: p.total, label: p.label }),
          );
          annual.finishJob(account.id, year, result.pdf, result.pages);
          send({ type: 'done', year, pages: result.pages, bytes: result.pdf.length });
        } catch (e) {
          annual.finishJob(account.id, year, null);
          const code = (e as { code?: string }).code;
          if (code !== 'ABORTED') {
            console.error('[v1] annual export failed', e);
            send({ type: 'error', code: 'INTERNAL', message: 'annual export failed' });
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

exportsRoutes.get('/exports/annual/:year/file', async (c) => {
  const year = Number(c.req.param('year'));
  if (!Number.isInteger(year)) return err(c, 'VALIDATION', 'bad year');
  const job = annual.getJob(c.get('account').id, year);
  if (job?.status !== 'done' || !job.pdf) return err(c, 'NOT_FOUND', 'no finished book — generate first');
  return c.body(new Uint8Array(job.pdf), 200, {
    'content-type': 'application/pdf',
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="keepsake-${year}.pdf"`,
  });
});

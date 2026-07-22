import { Hono } from 'hono';
import * as changeFeed from '../changeFeed.ts';
import { SSE_HEADERS, v1Frame } from './sse.ts';
import { requireAuth, type AppEnv } from './middleware.ts';

export const changesRoutes = new Hono<AppEnv>();

const HEARTBEAT_MS = Number(process.env.CHANGES_HEARTBEAT_MS) || 25_000;
// bounded stream lifetime, well inside the 1h access-token TTL; clients reconnect
const MAX_STREAM_MS = 20 * 60_000;

/** Long-lived SSE feed of this account's entry changes. Frames:
 *  {type:"cursor",seq} — position to resume from (sent on connect / after replay)
 *  {type:"change",seq,entryId,kind} — kind: created|updated|deleted
 *  {type:"resync",seq} — cursor not replayable, do a full refetch
 *  {type:"ping"} — heartbeat
 *  requireAuth, NOT requireKeys: events carry no decrypted content, and the feed
 *  must stay up after a restart so clients wake and prompt for unlock. Mounted
 *  before entriesRoutes so it matches ahead of /entries/:id and its requireKeys. */
changesRoutes.get('/entries/changes', requireAuth, async (c) => {
  const ownerId = c.get('account').id;
  const sinceRaw = c.req.query('since');
  const since = sinceRaw !== undefined && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(v1Frame(obj));
        } catch {
          cleanup();
        }
      };
      if (since === undefined) {
        send({ type: 'cursor', seq: changeFeed.currentSeq() });
      } else {
        const missed = changeFeed.replaySince(ownerId, since);
        if (missed === null) {
          send({ type: 'resync', seq: changeFeed.currentSeq() });
        } else {
          for (const e of missed) send({ type: 'change', seq: e.seq, entryId: e.entryId, kind: e.kind });
          send({ type: 'cursor', seq: changeFeed.currentSeq() });
        }
      }
      const unsubscribe = changeFeed.subscribe(ownerId, (e) =>
        send({ type: 'change', seq: e.seq, entryId: e.entryId, kind: e.kind }),
      );
      const heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);
      const deadline = setTimeout(() => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already gone
        }
      }, MAX_STREAM_MS);
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(deadline);
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { auth, json, startServer, testJpeg, uploadForm } from './helpers.ts';

interface Frame {
  type: string;
  seq?: number;
  entryId?: string;
  kind?: string;
}

function openFeed(base: string, token: string, since?: number) {
  const url = `${base}/api/v1/entries/changes${since === undefined ? '' : `?since=${since}`}`;
  const frames: Frame[] = [];
  let notify: (() => void) | null = null;
  let status = 0;
  const ready = (async () => {
    const res = await fetch(url, { headers: auth(token) });
    status = res.status;
    if (!res.ok || !res.body) return null;
    return res.body.getReader();
  })();
  const pump = (async () => {
    const reader = await ready;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        frames.push(JSON.parse(line.slice(5).trim()) as Frame);
        notify?.();
      }
    }
  })().catch(() => {});
  return {
    frames,
    status: async () => {
      await ready;
      return status;
    },
    waitFor: async (pred: (f: Frame) => boolean, ms = 5000): Promise<Frame> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await new Promise<void>((r) => {
          notify = r;
          setTimeout(r, 100);
        });
      }
      throw new Error(`frame not received; got: ${frames.map((f) => f.type).join(',')}`);
    },
    close: async () => {
      const reader = await ready;
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
}

test('entry change feed: delivery, isolation, replay, resync, locked keyring', { timeout: 60_000 }, async () => {
  const server = await startServer(5, { CHANGES_HEARTBEAT_MS: '300' });
  try {
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'password123', displayName: 'Owner' }),
    });
    assert.equal(boot.response.status, 200);
    const ownerToken = boot.body.accessToken as string;
    const ownerHeader = auth(ownerToken);

    // second family member — proves events are per-owner, not per-scope
    const reg = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal',
        username: 'member_one',
        password: 'password123',
        displayName: 'Member',
      }),
    });
    const memberToken = reg.body.accessToken as string;
    const memberHeader = auth(memberToken);
    await json(server.base, '/api/v1/family/invites', {
      method: 'POST',
      headers: ownerHeader,
      body: JSON.stringify({ username: 'member_one' }),
    });
    const invites = await json(server.base, '/api/v1/me/invites', { headers: memberHeader });
    await json(server.base, `/api/v1/me/invites/${invites.body.items[0].id}/accept`, {
      method: 'POST',
      headers: memberHeader,
      body: '{}',
    });

    const ownerFeed = openFeed(server.base, ownerToken);
    const memberFeed = openFeed(server.base, memberToken);
    assert.equal(await ownerFeed.status(), 200);
    const cursor0 = await ownerFeed.waitFor((f) => f.type === 'cursor');
    await memberFeed.waitFor((f) => f.type === 'cursor');

    // created event reaches the owner, not the family member
    const entryId = crypto.randomUUID();
    const up = await fetch(`${server.base}/api/v1/entries`, {
      method: 'POST',
      headers: ownerHeader,
      body: uploadForm(entryId, Date.now(), { image: testJpeg(11), thumb: testJpeg(11) }),
    });
    assert.equal(up.status, 201);
    const created = await ownerFeed.waitFor((f) => f.type === 'change' && f.entryId === entryId);
    assert.equal(created.kind, 'created');
    // heartbeat proves liveness while the member's feed stays clean of foreign events
    await memberFeed.waitFor((f) => f.type === 'ping');
    assert.equal(memberFeed.frames.filter((f) => f.type === 'change').length, 0);

    // updated + deleted events
    await json(server.base, `/api/v1/entries/${entryId}`, {
      method: 'PATCH',
      headers: ownerHeader,
      body: JSON.stringify({ title: 'renamed' }),
    });
    const updated = await ownerFeed.waitFor(
      (f) => f.type === 'change' && f.entryId === entryId && f.kind === 'updated',
    );
    const otherId = crypto.randomUUID();
    await fetch(`${server.base}/api/v1/entries`, {
      method: 'POST',
      headers: ownerHeader,
      body: uploadForm(otherId, Date.now(), { image: testJpeg(12), thumb: testJpeg(12) }),
    });
    await fetch(`${server.base}/api/v1/entries/${otherId}`, { method: 'DELETE', headers: ownerHeader });
    await ownerFeed.waitFor((f) => f.type === 'change' && f.entryId === otherId && f.kind === 'deleted');
    await ownerFeed.close();
    await memberFeed.close();

    // reconnect with a valid cursor replays what was missed
    const replayFeed = openFeed(server.base, ownerToken, cursor0.seq);
    const replayed = await replayFeed.waitFor(
      (f) => f.type === 'change' && f.entryId === entryId && f.kind === 'created',
    );
    assert.ok(replayed.seq! > cursor0.seq!);
    await replayFeed.waitFor((f) => f.type === 'cursor' && f.seq! >= updated.seq!);
    assert.equal(replayFeed.frames.some((f) => f.type === 'resync'), false);
    await replayFeed.close();

    // unknown/future cursor → resync
    const resyncFeed = openFeed(server.base, ownerToken, 999_999);
    await resyncFeed.waitFor((f) => f.type === 'resync');
    await resyncFeed.close();

    // after a restart the keyring is empty: entries 423s but the feed still opens
    // (requireAuth, not requireKeys) and tells the client to resync
    await server.restart();
    const locked = await json(server.base, '/api/v1/entries', { headers: ownerHeader });
    assert.equal(locked.response.status, 423);
    const lockedFeed = openFeed(server.base, ownerToken, updated.seq);
    assert.equal(await lockedFeed.status(), 200);
    await lockedFeed.waitFor((f) => f.type === 'resync');
    await lockedFeed.close();
  } finally {
    await server.cleanup();
  }
});

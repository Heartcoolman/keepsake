import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { auth, json, scanForPlaintext, startServer, uploadForm } from './helpers.ts';

const FONT_PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/fonts/NotoSerifCJKsc-SemiBold.otf',
);

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let names: string[] = [];
  try {
    names = await readdir(dir, { withFileTypes: true } as never) as never;
  } catch {
    return 0;
  }
  for (const d of names as unknown as { name: string; isDirectory(): boolean }[]) {
    if (d.isDirectory()) n += await countFiles(join(dir, d.name));
    else n += 1;
  }
  return n;
}

async function realJpeg(hue: number): Promise<Blob> {
  const buf = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 40 + hue, g: 90, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

test('memory exports: share card and annual book', { timeout: 180_000 }, async (t) => {
  if (!existsSync(FONT_PROBE)) {
    t.skip('export fonts not fetched (run scripts/fetch-fonts.sh)');
    return;
  }
  const server = await startServer(5);
  try {
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'password123', displayName: '李吉' }),
    });
    assert.equal(boot.response.status, 200);
    const owner = auth(boot.body.accessToken);
    const reg = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal',
        username: 'stranger',
        password: 'password123',
        displayName: 'Other',
      }),
    });
    assert.equal(reg.response.status, 201);
    const stranger = auth(reg.body.accessToken);

    const id = crypto.randomUUID();
    const photo = await realJpeg(0);
    const up = await fetch(`${server.base}/api/v1/entries`, {
      method: 'POST',
      headers: owner,
      body: uploadForm(id, Date.now(), {
        meta: { clientUploadId: crypto.randomUUID() },
        image: photo,
        thumb: photo,
      }),
    });
    assert.equal(up.status, 201);
    const diaryMarker = '那天风很大,你站在礁石上回头喊我,声音被浪花揉碎了一半。';
    const patch = await json(server.base, `/api/v1/entries/${id}`, {
      method: 'PATCH',
      headers: owner,
      body: JSON.stringify({
        title: '海边的下午',
        diaryText: diaryMarker.repeat(4),
        mood: '开心',
      }),
    });
    assert.equal(patch.response.status, 200);

    // ---- share card
    const card = await fetch(`${server.base}/api/v1/exports/card/${id}`, { headers: owner });
    assert.equal(card.status, 200);
    assert.equal(card.headers.get('content-type'), 'image/jpeg');
    const cardBuf = Buffer.from(await card.arrayBuffer());
    assert.ok(cardBuf.length > 10_000, `card unexpectedly small: ${cardBuf.length}`);
    assert.deepEqual([...cardBuf.subarray(0, 3)], [0xff, 0xd8, 0xff]);

    // ownership & auth walls
    assert.equal(
      (await fetch(`${server.base}/api/v1/exports/card/${id}`, { headers: stranger })).status,
      404,
    );
    assert.equal((await fetch(`${server.base}/api/v1/exports/card/${id}`)).status, 401);

    // snapshot data dir before the annual export — exports must write nothing
    const filesBefore = await countFiles(server.dataDir);

    // ---- annual book
    const year = new Date().getFullYear();
    const empty = await json(server.base, '/api/v1/exports/annual', {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ year: 2001 }),
    });
    assert.equal(empty.response.status, 400);

    const gen = await fetch(`${server.base}/api/v1/exports/annual`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ year }),
    });
    assert.equal(gen.status, 200);
    assert.ok((gen.headers.get('content-type') ?? '').includes('text/event-stream'));
    const frames = (await gen.text())
      .split('\n\n')
      .map((f) => f.trim())
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)) as { type: string; pages?: number; label?: string });
    assert.ok(frames.some((f) => f.type === 'progress'), 'no progress frames');
    const done = frames.find((f) => f.type === 'done');
    assert.ok(done, `no done frame: ${JSON.stringify(frames.at(-1))}`);
    assert.ok((done.pages ?? 0) >= 4, `too few pages: ${done.pages}`);

    const file = await fetch(`${server.base}/api/v1/exports/annual/${year}/file`, {
      headers: owner,
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await file.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(
      (await fetch(`${server.base}/api/v1/exports/annual/${year}/file`, { headers: stranger }))
        .status,
      404,
    );

    // exports leave no files and no plaintext behind
    assert.equal(await countFiles(server.dataDir), filesBefore, 'export wrote into data dir');
    assert.deepEqual(await scanForPlaintext([server.dataDir], ['海边的下午', diaryMarker]), []);

    // keyring lost on restart → exports are locked like every data route
    await server.restart();
    assert.equal(
      (await fetch(`${server.base}/api/v1/exports/card/${id}`, { headers: owner })).status,
      423,
    );
    assert.equal(
      (
        await fetch(`${server.base}/api/v1/exports/annual`, {
          method: 'POST',
          headers: { ...owner, 'content-type': 'application/json' },
          body: JSON.stringify({ year }),
        })
      ).status,
      423,
    );
  } finally {
    await server.stop();
    await server.cleanup();
  }
});

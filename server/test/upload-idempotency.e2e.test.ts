import assert from 'node:assert/strict';
import test from 'node:test';
import { auth, json, startServer, testJpeg, uploadForm } from './helpers.ts';

test('upload idempotency and per-owner image dedup', { timeout: 60_000 }, async () => {
  const server = await startServer(3);
  try {
    const boot = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'password123', displayName: 'Owner' }),
    });
    assert.equal(boot.response.status, 200);
    const ownerHeader = auth(boot.body.accessToken);

    const upload = (form: FormData, headers: Record<string, string>) =>
      fetch(`${server.base}/api/v1/entries`, { method: 'POST', headers, body: form });

    // create, then replay the same clientUploadId → 200 with the original entry
    const cuid = crypto.randomUUID();
    const idA = crypto.randomUUID();
    const first = await upload(
      uploadForm(idA, Date.now(), {
        meta: { clientUploadId: cuid },
        image: testJpeg(1),
        thumb: testJpeg(1),
      }),
      ownerHeader,
    );
    assert.equal(first.status, 201);
    const replay = await upload(
      uploadForm(crypto.randomUUID(), Date.now(), {
        meta: { clientUploadId: cuid },
        image: testJpeg(1),
        thumb: testJpeg(1),
      }),
      ownerHeader,
    );
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.id, idA);
    assert.equal(replayed.clientUploadId, cuid);

    // fresh clientUploadId, identical bytes → 409 DUPLICATE_IMAGE with hint, no new entry
    const dup = await upload(
      uploadForm(crypto.randomUUID(), Date.now(), {
        meta: { clientUploadId: crypto.randomUUID() },
        image: testJpeg(1),
        thumb: testJpeg(1),
      }),
      ownerHeader,
    );
    assert.equal(dup.status, 409);
    const dupBody = await dup.json();
    assert.equal(dupBody.error.code, 'DUPLICATE_IMAGE');
    assert.equal(dupBody.duplicateOf.id, idA);
    assert.ok(dupBody.duplicateOf.takenAt > 0);

    // override → created anyway
    const idB = crypto.randomUUID();
    const forced = await upload(
      uploadForm(idB, Date.now(), {
        meta: { clientUploadId: crypto.randomUUID() },
        image: testJpeg(1),
        thumb: testJpeg(1),
        override: true,
      }),
      ownerHeader,
    );
    assert.equal(forced.status, 201);
    const list = await json(server.base, '/api/v1/entries', { headers: ownerHeader });
    assert.equal(list.body.items.length, 2);

    // a different owner uploading the same bytes is not a duplicate
    const reg = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        accountType: 'personal',
        username: 'owner_two',
        password: 'password123',
        displayName: 'Other',
      }),
    });
    assert.equal(reg.response.status, 201);
    const otherUp = await upload(
      uploadForm(crypto.randomUUID(), Date.now(), { image: testJpeg(1), thumb: testJpeg(1) }),
      auth(reg.body.accessToken),
    );
    assert.equal(otherUp.status, 201);

    // concurrent same-owner same-bytes race → exactly one created, one duplicate
    const race = await Promise.all(
      [0, 1].map(() =>
        upload(
          uploadForm(crypto.randomUUID(), Date.now(), {
            meta: { clientUploadId: crypto.randomUUID() },
            image: testJpeg(7),
            thumb: testJpeg(7),
          }),
          ownerHeader,
        ),
      ),
    );
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);

    // clientUploadId is not patchable
    const patched = await json(server.base, `/api/v1/entries/${idA}`, {
      method: 'PATCH',
      headers: ownerHeader,
      body: JSON.stringify({ clientUploadId: 'forged' }),
    });
    assert.equal(patched.response.status, 400);
  } finally {
    await server.cleanup();
  }
});

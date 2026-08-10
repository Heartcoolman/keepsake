/** PersonRef.cx must survive sanitize + disk round-trip: it is the only input to
 *  prompts.positionLabels, so a field dropped anywhere on the write path silently
 *  disables the left/right grounding without failing any other assertion. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Load store.ts from a throwaway copy so its data/ dir lives under a temp path. */
async function loadStore(temp: string, revision = 1) {
  const url = pathToFileURL(resolve(temp, 'src/store.ts')).href;
  return (await import(`${url}?rev=${revision}`)) as typeof import('../src/store.ts');
}

test('PersonRef.cx survives sanitize, patch and a fresh read from disk', async () => {
  const temp = await mkdtemp(`${tmpdir()}/nianxiang-store-`);
  try {
    await mkdir(resolve(temp, 'src'), { recursive: true });
    await cp(resolve(SERVER_ROOT, 'src'), resolve(temp, 'src'), { recursive: true });
    await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(temp, 'node_modules'), 'dir');

    const store = await loadStore(temp);
    const udk = randomBytes(32);
    const id = 'entry-cx-roundtrip';

    // 1. sanitizeMeta keeps cx and clamps it into 0..1
    const sanitized = store.sanitizeMeta({
      id,
      ownerId: 'owner-1',
      people: [
        { personId: 'person-alpha-0001', faceIndex: 0, cx: 0.17 },
        { personId: 'person-bravo-0002', faceIndex: 1, cx: 1.8 },
        { personId: 'person-charlie-0003', faceIndex: 2, cx: -0.4 },
        { personId: 'person-delta-0004', faceIndex: 3 },
        { personId: 'person-echo-0005', faceIndex: 4, cx: 'nope' },
      ],
    });
    assert.deepEqual(
      sanitized.people.map((p) => p.cx),
      [0.17, 1, 0, undefined, undefined],
      'cx must be preserved and clamped, non-numeric dropped',
    );

    // 2. a create never takes refs from the uploader — the scan supplies them
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const scopeKey = randomBytes(32);
    assert.equal(await store.putEntry(sanitized, jpeg, jpeg, udk), true);
    assert.deepEqual((await store.getEntry(id))?.people, [], 'refs must not ride in on create');

    // 3. survives the keyed write that face.scanEntry actually uses
    await store.patchEntryFaces(
      id,
      {
        people: [
          { personId: 'person-alpha-0001', faceIndex: 0, cx: 0.82 },
          { personId: 'person-bravo-0002', faceIndex: 1, cx: 0.31 },
        ],
        unknownFaces: 0,
        faceScannedAt: Date.now(),
      },
      scopeKey,
    );
    assert.deepEqual(
      (await store.readEntryFaces(id, scopeKey))?.people.map((p) => p.cx),
      [0.82, 0.31],
    );

    // 3b. …and they are readable ONLY with that key: {personId, faceIndex} per entry
    // is the co-occurrence graph, so the structural view and the file must not carry it
    assert.deepEqual((await store.getEntry(id))?.people, [], 'structural view must not carry refs');
    assert.deepEqual((await store.readEntryFaces(id, undefined))?.people, []);
    const onDisk = await readFile(resolve(temp, `data/entries/${id}.json`), 'utf8');
    for (const marker of ['person-alpha-0001', 'person-bravo-0002', '0.82']) {
      assert.ok(!onDisk.includes(marker), `entry file leaks ${marker}`);
    }

    // 4. survives a cold read: a second module instance re-parses the JSON off disk
    const reloaded = await loadStore(temp, 2);
    assert.deepEqual(
      (await reloaded.readEntryFaces(id, scopeKey))?.people.map((p) => p.cx),
      [0.82, 0.31],
      'cx must be persisted, not just held in memory',
    );

    // 5. positionLabels can therefore actually label them
    const promptsUrl = pathToFileURL(resolve(temp, 'src/prompts.ts')).href;
    const { positionLabels } = (await import(promptsUrl)) as typeof import('../src/prompts.ts');
    const faces = await reloaded.readEntryFaces(id, scopeKey);
    assert.deepEqual(positionLabels(faces!.people), ['右边', '左边']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

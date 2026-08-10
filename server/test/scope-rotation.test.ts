/** A family-key rotation re-encrypts a whole scope without a transaction, so the
 *  re-encryption pass has to be resumable: running it again over a scope that is
 *  already (or partially) migrated must converge instead of throwing. That is what
 *  makes an interrupted rotation recoverable rather than data loss. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'family-rotate';

async function loadPeople(temp: string) {
  const url = pathToFileURL(resolve(temp, 'src/people.ts')).href;
  return (await import(url)) as typeof import('../src/people.ts');
}

async function loadRelationships(temp: string) {
  const url = pathToFileURL(resolve(temp, 'src/relationships.ts')).href;
  return (await import(url)) as typeof import('../src/relationships.ts');
}

async function loadStore(temp: string) {
  const url = pathToFileURL(resolve(temp, 'src/store.ts')).href;
  return (await import(url)) as typeof import('../src/store.ts');
}

async function sandbox(prefix: string): Promise<string> {
  const temp = await mkdtemp(`${tmpdir()}/${prefix}`);
  await mkdir(resolve(temp, 'src'), { recursive: true });
  await cp(resolve(SERVER_ROOT, 'src'), resolve(temp, 'src'), { recursive: true });
  await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(temp, 'node_modules'), 'dir');
  return temp;
}

function person(id: string, name: string) {
  const now = Date.now();
  return {
    id,
    scopeId: SCOPE,
    name,
    relation: '朋友',
    relations: {},
    isUser: false,
    createdAt: now,
    updatedAt: now,
    templates: [],
    enrolledFrom: [],
  };
}

test('scope re-encryption is idempotent and resumes over partial migrations', async () => {
  const temp = await sandbox('nianxiang-rotate-');
  try {
    const people = await loadPeople(temp);
    const oldFk = randomBytes(32);
    const newFk = randomBytes(32);

    await people.putPerson(person('p1', '晓雯'), oldFk);
    await people.putPerson(person('p2', '阿哲'), oldFk);

    // ---------- a complete pass moves the scope onto the new key ----------
    await people.reencryptScope(SCOPE, oldFk, newFk);
    assert.equal((await people.getPerson('p1', newFk))?.name, '晓雯');
    assert.equal((await people.getPerson('p2', newFk))?.name, '阿哲');

    // ---------- replaying the same pass must not throw on already-migrated rows ----------
    await people.reencryptScope(SCOPE, oldFk, newFk);
    assert.equal((await people.getPerson('p1', newFk))?.name, '晓雯');
    assert.equal((await people.getPerson('p2', newFk))?.name, '阿哲');

    // ---------- a half-finished rotation converges on a retry ----------
    // p2 back on the old key: exactly the state a crash mid-pass leaves behind.
    await people.putPerson(person('p2', '阿哲'), oldFk);
    await assert.rejects(
      () => people.getPerson('p2', newFk) as Promise<unknown>,
      'precondition: p2 is genuinely on the old key',
    );

    await people.reencryptScope(SCOPE, oldFk, newFk);
    assert.equal((await people.getPerson('p1', newFk))?.name, '晓雯', 'already-migrated row survives');
    assert.equal((await people.getPerson('p2', newFk))?.name, '阿哲', 'stranded row is picked up');

    // ---------- and the old key no longer opens anything ----------
    await assert.rejects(() => people.getPerson('p1', oldFk) as Promise<unknown>);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/** Relationship records are named by a tag derived from the scope key, so a rotation
 *  has to MOVE each file, not just rewrite it. That makes the rename the fragile part:
 *  a bug here either strands an edge under a tag nobody can compute again, or leaves
 *  the pre-rotation copy behind as a duplicate. */
test('relationship rotation re-tags every edge and resumes over a stranded one', async () => {
  const temp = await sandbox('nianxiang-rel-rotate-');
  try {
    const rel = await loadRelationships(temp);
    const dir = resolve(temp, 'data/relationships');
    const oldFk = randomBytes(32);
    const newFk = randomBytes(32);

    await rel.upsertCooccurrence('p1', 'p2', 'e1', SCOPE, oldFk);
    await rel.upsertCooccurrence('p1', 'p3', 'e1', SCOPE, oldFk);

    const before = (await readdir(dir)).sort();
    assert.equal(before.length, 2);
    for (const name of before) assert.ok(!name.includes('__'), `${name} leaks its endpoints`);

    // ---------- a complete pass moves every edge onto the new key ----------
    await rel.reencryptScope(SCOPE, oldFk, newFk);
    const rotated = await rel.listRelationships(SCOPE, newFk);
    assert.deepEqual(rotated.map((r) => r.id).sort(), ['p1__p2', 'p1__p3']);
    const after = (await readdir(dir)).sort();
    assert.equal(after.length, 2, 'the pre-rotation copies must not linger');
    assert.notDeepEqual(after, before, 'the tag is key-bound, so the filenames change');
    // The retired key opens nothing. It yields an empty list rather than throwing:
    // one unreadable edge must never take down the whole graph route.
    assert.deepEqual(await rel.listRelationships(SCOPE, oldFk), []);

    // ---------- replaying the pass is a no-op, not a duplicate ----------
    await rel.reencryptScope(SCOPE, oldFk, newFk);
    assert.equal((await rel.listRelationships(SCOPE, newFk)).length, 2);
    assert.deepEqual((await readdir(dir)).sort(), after);

    // ---------- a crash-stranded edge on the old key is picked up on retry ----------
    assert.equal(await rel.deleteRelationshipInScope('p1__p3', SCOPE, newFk), true);
    await rel.upsertCooccurrence('p1', 'p3', 'e1', SCOPE, oldFk);
    await rel.reencryptScope(SCOPE, oldFk, newFk);
    const resumed = await rel.listRelationships(SCOPE, newFk);
    assert.deepEqual(resumed.map((r) => r.id).sort(), ['p1__p2', 'p1__p3'], 'stranded edge recovered');
    assert.equal((await readdir(dir)).length, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/** Entries hold face refs under the SCOPE key, so removing a family member — which
 *  rotates that key — has to re-encrypt them too. Miss this and every photo's face
 *  links become permanently unreadable: nothing else can recover them, because the
 *  old key is deliberately destroyed. */
test('entry face refs follow a family-key rotation', async () => {
  const temp = await sandbox('nianxiang-faces-rotate-');
  try {
    const store = await loadStore(temp);
    const udk = randomBytes(32);
    const oldFk = randomBytes(32);
    const newFk = randomBytes(32);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const id = 'entry-rotate';

    const meta = store.sanitizeMeta({ id, ownerId: 'owner-1', familyId: SCOPE });
    assert.equal(await store.putEntry(meta, jpeg, jpeg, udk), true);
    await store.patchEntryFaces(
      id,
      {
        people: [{ personId: 'p1', faceIndex: 0, cx: 0.4 }],
        unknownFaces: 1,
        faceScannedAt: Date.now(),
      },
      oldFk,
    );

    await store.reencryptScopePeople(SCOPE, oldFk, newFk);
    assert.deepEqual(
      (await store.readEntryFaces(id, newFk))?.people.map((p) => p.personId),
      ['p1'],
      'refs must open with the key the scope now uses',
    );
    assert.deepEqual((await store.readEntryFaces(id, oldFk))?.people, [], 'old key must be dead');

    // replaying the pass over already-migrated rows must converge, not corrupt
    await store.reencryptScopePeople(SCOPE, oldFk, newFk);
    assert.deepEqual((await store.readEntryFaces(id, newFk))?.people.map((p) => p.cx), [0.4]);
    // and the counter that stays structural is untouched by the re-key
    assert.equal((await store.getEntry(id))?.unknownFaces, 1);

    // ---------- one unopenable record must not abort the pass ----------
    // A record sealed under neither key (an entry whose scope was reassigned while
    // its refs were still sealed to the old one) used to throw straight out of the
    // loop: every entry ordered after it stayed un-rotated, and because rotation
    // replays deterministically it aborted the same way on every later login,
    // wedging the whole family's catchup rather than losing one entry's refs.
    const orphanId = 'entry-orphan';
    assert.equal(
      await store.putEntry(
        store.sanitizeMeta({ id: orphanId, ownerId: 'owner-1', familyId: SCOPE }),
        jpeg,
        jpeg,
        udk,
      ),
      true,
    );
    await store.patchEntryFaces(
      orphanId,
      { people: [{ personId: 'person-foxtrot-0006', faceIndex: 0 }], unknownFaces: 0, faceScannedAt: Date.now() },
      randomBytes(32), // a third key: neither side of the rotation can open this
    );
    const laterId = 'entry-after-orphan';
    assert.equal(
      await store.putEntry(
        store.sanitizeMeta({ id: laterId, ownerId: 'owner-1', familyId: SCOPE }),
        jpeg,
        jpeg,
        udk,
      ),
      true,
    );
    await store.patchEntryFaces(
      laterId,
      { people: [{ personId: 'person-golf-0007', faceIndex: 0 }], unknownFaces: 0, faceScannedAt: Date.now() },
      newFk,
    );

    const thirdFk = randomBytes(32);
    await store.reencryptScopePeople(SCOPE, newFk, thirdFk);
    assert.deepEqual(
      (await store.readEntryFaces(laterId, thirdFk))?.people.map((p) => p.personId),
      ['person-golf-0007'],
      'entries after the unopenable one must still be re-keyed',
    );
    assert.deepEqual(
      (await store.readEntryFaces(id, thirdFk))?.people.map((p) => p.cx),
      [0.4],
      'entries before it too',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

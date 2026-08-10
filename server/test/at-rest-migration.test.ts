/** Upgrade paths for data written by the PREVIOUS release — the shapes a running
 *  deployment actually has on disk, which no fresh-install test ever produces:
 *
 *  - a relationship whose envelope holds only {label, evidence}, with its endpoints
 *    and confidence beside it in the clear (that outer copy is the only one it has);
 *  - an entry whose content is already encrypted but whose face refs are still a
 *    plaintext array (the owner-keyed entry migration skips such rows — their
 *    content is not legacy — so only a scope-keyed pass can reach them).
 *
 *  Both must keep reading, then migrate into the sealed shape. Getting this wrong
 *  is silent, permanent data loss on a real install rather than a failing test. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'family-upgrade';

async function sandbox(prefix: string): Promise<string> {
  const temp = await mkdtemp(`${tmpdir()}/${prefix}`);
  await mkdir(resolve(temp, 'src'), { recursive: true });
  await cp(resolve(SERVER_ROOT, 'src'), resolve(temp, 'src'), { recursive: true });
  await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(temp, 'node_modules'), 'dir');
  return temp;
}

const load = async <T>(temp: string, file: string, rev = 1): Promise<T> =>
  (await import(`${pathToFileURL(resolve(temp, `src/${file}`)).href}?rev=${rev}`)) as T;

test('a relationship from the previous release still opens, then migrates', async () => {
  const temp = await sandbox('nianxiang-relup-');
  try {
    const crypto = await load<typeof import('../src/crypto.ts')>(temp, 'crypto.ts');
    const fk = randomBytes(32);
    const now = Date.now();

    // exactly the previous on-disk shape: endpoints outside, {label, evidence} inside
    await mkdir(resolve(temp, 'data/relationships'), { recursive: true });
    await writeFile(
      resolve(temp, 'data/relationships/person-alpha-0001__person-bravo-0002.json'),
      JSON.stringify({
        id: 'person-alpha-0001__person-bravo-0002',
        a: 'person-alpha-0001',
        b: 'person-bravo-0002',
        scopeId: SCOPE,
        confidence: 0.9,
        createdAt: now,
        updatedAt: now,
        enc: crypto.encryptJson(
          { label: '母子', evidence: [{ entryId: 'e1', kind: 'ai', createdAt: now }] },
          fk,
        ),
      }),
    );

    const rel = await load<typeof import('../src/relationships.ts')>(temp, 'relationships.ts');

    // 1. it must still read — endpoints from the outer fields, label from the envelope
    const [edge] = await rel.listRelationships(SCOPE, fk);
    assert.ok(edge, 'the pre-upgrade edge must still be readable');
    assert.equal(edge.id, 'person-alpha-0001__person-bravo-0002');
    assert.equal(edge.label, '母子');
    assert.equal(edge.confidence, 0.9);
    assert.deepEqual(edge.evidence.map((e) => e.entryId), ['e1']);

    // 2. it is reported as needing migration, and migrating re-tags + seals it
    assert.deepEqual(await rel.listLegacyRelationshipIds(SCOPE), ['person-alpha-0001__person-bravo-0002']);
    assert.equal(await rel.encryptRelationshipRecord('person-alpha-0001__person-bravo-0002', fk), true);

    const files = await readdir(resolve(temp, 'data/relationships'));
    assert.equal(files.length, 1, 'the old file must be gone, not duplicated');
    assert.ok(!files[0]!.includes('__'), `still named by its pair: ${files[0]}`);
    const body = await readFile(resolve(temp, `data/relationships/${files[0]}`), 'utf8');
    for (const marker of ['person-alpha-0001', 'person-bravo-0002', '母子', '0.9']) {
      assert.ok(!body.includes(marker), `migrated edge still leaks ${marker}`);
    }

    // 3. and it reads identically afterwards, from a cold index
    const reloaded = await load<typeof import('../src/relationships.ts')>(temp, 'relationships.ts', 2);
    const [after] = await reloaded.listRelationships(SCOPE, fk);
    assert.equal(after?.id, 'person-alpha-0001__person-bravo-0002');
    assert.equal(after?.label, '母子');
    assert.equal(after?.confidence, 0.9);
    assert.deepEqual(after?.evidence.map((e) => e.entryId), ['e1']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('entry face refs written before the refs envelope get sealed by the scope pass', async () => {
  const temp = await sandbox('nianxiang-faceup-');
  try {
    const store = await load<typeof import('../src/store.ts')>(temp, 'store.ts');
    const udk = randomBytes(32);
    const fk = randomBytes(32);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const id = 'entry-upgrade';

    // content encrypted (so the owner-keyed migration considers it done) …
    assert.equal(
      await store.putEntry(
        store.sanitizeMeta({ id, ownerId: 'owner-1', familyId: SCOPE }),
        jpeg,
        jpeg,
        udk,
      ),
      true,
    );
    // … while the refs sit in the clear, the way the previous release left them
    const path = resolve(temp, `data/entries/${id}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.people = [{ personId: 'person-charlie-0003', faceIndex: 0, cx: 0.4 }];
    raw.unknownFaces = 1;
    raw.faceScannedAt = Date.now();
    await writeFile(path, JSON.stringify(raw));

    const reloaded = await load<typeof import('../src/store.ts')>(temp, 'store.ts', 2);
    // readable before migration — no key needed while they are plaintext
    assert.deepEqual(
      (await reloaded.readEntryFaces(id, undefined))?.people.map((p) => p.personId),
      ['person-charlie-0003'],
    );

    assert.equal(await reloaded.encryptScopePeople(SCOPE, fk), 1);
    assert.deepEqual(
      (await reloaded.readEntryFaces(id, fk))?.people.map((p) => p.cx),
      [0.4],
      'refs must survive the seal',
    );
    assert.deepEqual((await reloaded.readEntryFaces(id, undefined))?.people, []);
    const body = await readFile(path, 'utf8');
    assert.ok(!body.includes('person-charlie-0003'), 'entry file still leaks the person id');
    assert.ok(body.includes('encPeople'), 'refs must be stored as an envelope');

    // a second pass is a no-op, not a double-encrypt
    assert.equal(await reloaded.encryptScopePeople(SCOPE, fk), 0);
    assert.deepEqual((await reloaded.readEntryFaces(id, fk))?.people.map((p) => p.cx), [0.4]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

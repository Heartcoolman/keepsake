/** A family-key rotation re-encrypts a whole scope without a transaction, so the
 *  re-encryption pass has to be resumable: running it again over a scope that is
 *  already (or partially) migrated must converge instead of throwing. That is what
 *  makes an interrupted rotation recoverable rather than data loss. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'family-rotate';

async function loadPeople(temp: string) {
  const url = pathToFileURL(resolve(temp, 'src/people.ts')).href;
  return (await import(url)) as typeof import('../src/people.ts');
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
  const temp = await mkdtemp(`${tmpdir()}/nianxiang-rotate-`);
  try {
    await mkdir(resolve(temp, 'src'), { recursive: true });
    await cp(resolve(SERVER_ROOT, 'src'), resolve(temp, 'src'), { recursive: true });
    await symlink(resolve(SERVER_ROOT, 'node_modules'), resolve(temp, 'node_modules'), 'dir');

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

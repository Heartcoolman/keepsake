import assert from 'node:assert/strict';
import test from 'node:test';
import { auth, json, scanForPlaintext, startServer, uploadForm } from './helpers.ts';

const CHAT_TEXT = '今天和晓雯一起去海边看落日了';
const PERSON_NAME = '晓雯';

test('two families + at-rest encryption + locked restart + unlock + recovery + leave', { timeout: 60_000 }, async () => {
  const server = await startServer(1);
  try {
    // ---------- family A (bootstrap) + family B (open registration) ----------
    const bootA = await json(server.base, '/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_a', password: 'password123', familyName: 'A家' }),
    });
    assert.equal(bootA.response.status, 200);
    const ownerA = auth(bootA.body.accessToken);

    const regB = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'family', username: 'owner_b', password: 'password123', familyName: 'B家' }),
    });
    assert.equal(regB.response.status, 201);
    const ownerB = auth(regB.body.accessToken);
    assert.notEqual(regB.body.user.familyId, bootA.body.user.familyId);

    // standalone personal account (its own scope)
    const regSolo = await json(server.base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ accountType: 'personal', username: 'solo_one', password: 'password123' }),
    });
    assert.equal(regSolo.response.status, 201);
    const solo = auth(regSolo.body.accessToken);

    // ---------- content in family A: entry + chat + diary + shared person ----------
    const entryA = crypto.randomUUID();
    const uploadA = await fetch(`${server.base}/api/v1/entries`, {
      method: 'POST', headers: ownerA, body: uploadForm(entryA),
    });
    assert.equal(uploadA.status, 201);

    const personA = await json(server.base, '/api/v1/people', {
      method: 'POST', headers: ownerA, body: JSON.stringify({ name: PERSON_NAME, relation: '朋友' }),
    });
    assert.equal(personA.response.status, 201);

    // Produce encrypted content via public routes only (the session orchestration
    // lives in the private core; its behavior is covered by the core e2e suite).
    // analyze (MOCK) persists imageDescription; PATCH persists the diary text —
    // CHAT_TEXT is embedded in it so the chat marker exists on disk too.
    const analyzeA = await json(server.base, `/api/v1/entries/${entryA}/analyze`, {
      method: 'POST', headers: ownerA, body: '{}',
    });
    assert.equal(analyzeA.response.status, 200);
    const patchDiary = await json(server.base, `/api/v1/entries/${entryA}`, {
      method: 'PATCH',
      headers: ownerA,
      body: JSON.stringify({ diaryText: `${CHAT_TEXT}。回家后我把这段对话整理成了今天的日记。`, mood: '平静' }),
    });
    assert.equal(patchDiary.response.status, 200);

    // entry in family B and one in the solo scope
    const entryB = crypto.randomUUID();
    assert.equal(
      (await fetch(`${server.base}/api/v1/entries`, { method: 'POST', headers: ownerB, body: uploadForm(entryB) })).status,
      201,
    );
    const entrySolo = crypto.randomUUID();
    assert.equal(
      (await fetch(`${server.base}/api/v1/entries`, { method: 'POST', headers: solo, body: uploadForm(entrySolo) })).status,
      201,
    );
    const personSolo = await json(server.base, '/api/v1/people', {
      method: 'POST', headers: solo, body: JSON.stringify({ name: '独居友人', relation: '同事' }),
    });
    assert.equal(personSolo.response.status, 201);

    // ---------- cross-family isolation ----------
    const entriesB = await json(server.base, '/api/v1/entries', { headers: ownerB });
    assert.deepEqual(entriesB.body.items.map((e: { id: string }) => e.id), [entryB]);
    assert.equal((await fetch(`${server.base}/api/v1/entries/${entryA}`, { headers: ownerB })).status, 404);

    const peopleB = await json(server.base, '/api/v1/people', { headers: ownerB });
    assert.ok(!peopleB.body.items.some((p: { name: string }) => p.name === PERSON_NAME));
    const peopleSolo = await json(server.base, '/api/v1/people', { headers: solo });
    assert.ok(peopleSolo.body.items.some((p: { name: string }) => p.name === '独居友人'));
    assert.ok(!peopleSolo.body.items.some((p: { name: string }) => p.name === PERSON_NAME));

    const usersB = await json(server.base, '/api/v1/users', { headers: ownerB });
    assert.deepEqual(usersB.body.items.map((u: { username: string }) => u.username), ['owner_b']);

    const graphB = await json(server.base, '/api/v1/graph', { headers: ownerB });
    assert.ok(!graphB.body.nodes.some((n: { name: string }) => n.name === PERSON_NAME));

    // cross-family invite is rejected: solo can be invited, owner_b cannot
    const badInvite = await json(server.base, '/api/v1/family/invites', {
      method: 'POST', headers: ownerA, body: JSON.stringify({ username: 'owner_b' }),
    });
    assert.equal(badInvite.response.status, 400);

    // ---------- at-rest assertion: nothing sensitive readable off disk ----------
    const diary = await json(server.base, `/api/v1/entries/${entryA}`, { headers: ownerA });
    assert.ok(diary.body.diaryText.length > 0, 'diary persisted');
    const markers = [
      CHAT_TEXT,
      PERSON_NAME,
      diary.body.diaryText.slice(0, 24),
      diary.body.imageDescription.slice(0, 24),
      '独居友人',
    ];
    const hits = await scanForPlaintext([server.dataDir, server.cacheDir], markers);
    assert.deepEqual(hits, [], `plaintext found on disk:\n${hits.join('\n')}`);

    // ---------- restart: valid JWT but empty keyring → 423, unlock recovers ----------
    await server.restart();
    const locked = await json(server.base, '/api/v1/entries', { headers: ownerA });
    assert.equal(locked.response.status, 423);
    assert.equal(locked.body.error.code, 'E_KEYS_LOCKED');

    const badUnlock = await json(server.base, '/api/v1/auth/unlock', {
      method: 'POST', headers: ownerA, body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(badUnlock.response.status, 401);
    const unlock = await json(server.base, '/api/v1/auth/unlock', {
      method: 'POST', headers: ownerA, body: JSON.stringify({ password: 'password123' }),
    });
    assert.equal(unlock.response.status, 200);

    const afterUnlock = await json(server.base, `/api/v1/entries/${entryA}`, { headers: ownerA });
    assert.equal(afterUnlock.response.status, 200);
    assert.equal(afterUnlock.body.diaryText, diary.body.diaryText);
    const peopleAfter = await json(server.base, '/api/v1/people', { headers: ownerA });
    assert.ok(peopleAfter.body.items.some((p: { name: string }) => p.name === PERSON_NAME));

    // ---------- recovery code: forgotten password → full data access restored ----------
    const recover = await json(server.base, '/api/v1/auth/recover', {
      method: 'POST',
      body: JSON.stringify({
        username: 'solo_one',
        recoveryCode: regSolo.body.recoveryCode,
        newPassword: 'newpassword456',
      }),
    });
    assert.equal(recover.response.status, 200);
    assert.match(recover.body.recoveryCode, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
    assert.notEqual(recover.body.recoveryCode, regSolo.body.recoveryCode);
    const soloAfter = auth(recover.body.accessToken);
    const soloEntries = await json(server.base, '/api/v1/entries', { headers: soloAfter });
    assert.deepEqual(soloEntries.body.items.map((e: { id: string }) => e.id), [entrySolo]);
    const soloPeople = await json(server.base, '/api/v1/people', { headers: soloAfter });
    assert.ok(soloPeople.body.items.some((p: { name: string }) => p.name === '独居友人'));

    // ---------- invite → accept → leave rotates the family key ----------
    const inviteSolo = await json(server.base, '/api/v1/family/invites', {
      method: 'POST', headers: ownerA, body: JSON.stringify({ username: 'solo_one' }),
    });
    assert.equal(inviteSolo.response.status, 201);
    const soloInvites = await json(server.base, '/api/v1/me/invites', { headers: soloAfter });
    assert.equal(soloInvites.body.items.length, 1);
    const acceptSolo = await json(server.base, `/api/v1/me/invites/${soloInvites.body.items[0].id}/accept`, {
      method: 'POST', headers: soloAfter, body: '{}',
    });
    assert.equal(acceptSolo.response.status, 200);

    // inside the family: sees the shared person
    const soloFamilyPeople = await json(server.base, '/api/v1/people', { headers: soloAfter });
    assert.ok(soloFamilyPeople.body.items.some((p: { name: string }) => p.name === PERSON_NAME));

    const leave = await json(server.base, '/api/v1/me/family/leave', {
      method: 'POST', headers: soloAfter, body: '{}',
    });
    assert.equal(leave.response.status, 200);
    assert.equal(leave.body.user.familyId, null);

    // back to the personal scope: dormant personal people reappear, family people gone
    const soloBack = await json(server.base, '/api/v1/people', { headers: soloAfter });
    assert.ok(soloBack.body.items.some((p: { name: string }) => p.name === '独居友人'));
    assert.ok(!soloBack.body.items.some((p: { name: string }) => p.name === PERSON_NAME));

    // owner still has full family access after rotation
    const ownerPeopleAfterLeave = await json(server.base, '/api/v1/people', { headers: ownerA });
    assert.ok(ownerPeopleAfterLeave.body.items.some((p: { name: string }) => p.name === PERSON_NAME));
    const ownerEntriesAfterLeave = await json(server.base, `/api/v1/entries/${entryA}`, { headers: ownerA });
    assert.equal(ownerEntriesAfterLeave.body.diaryText, diary.body.diaryText);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver logs:\n${server.logs()}`);
  } finally {
    await server.cleanup();
  }
});

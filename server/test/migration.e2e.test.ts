/** Seed a pre-upgrade plaintext data dir (old account/entry/person shapes), boot
 *  the new server, log in → structural family migration + lazy at-rest encryption
 *  must leave the API contents identical and the disk free of plaintext. */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { hashPassword } from '../src/accounts.ts';
import { auth, json, scanForPlaintext, startServer } from './helpers.ts';

const DIARY = '傍晚的海风把一整天的疲惫都吹散了,我们沿着堤坝走了很久。';
const TITLE = '海边的黄昏';
const CHAT = '那天晓雯还带了相机,拍了好多照片';
const PERSON = '晓雯';
const MEMORY_TEXT = 'TA 喜欢傍晚去海边散步';
const MONTHLY = '这个月去了三次海边,每次都带回一点安静。';
const EMBEDDING = [0.13572468, -0.24681357, 0.98765432];

test('legacy plaintext data migrates to encrypted multi-family shape on first login', { timeout: 60_000 }, async () => {
  const server = await startServer(2);
  try {
    // stop the fresh boot; reseed the data dir with the OLD on-disk shapes
    await server.stop();
    // the empty first boot already stamped the migration markers — a real
    // pre-upgrade instance would not have them, so remove before seeding
    await rm(resolve(server.dataDir, 'migration-v1.json'), { force: true });
    await rm(resolve(server.dataDir, 'migration-family.json'), { force: true });
    const now = Date.now();
    const passwordHash = await hashPassword('password123');
    const dirs = ['accounts', 'entries', 'people', 'relationships', 'users', 'monthly'];
    for (const d of dirs) await mkdir(resolve(server.dataDir, d), { recursive: true });

    const oldAccount = (id: string, username: string, role: string) => ({
      id, username, passwordHash, displayName: username, role,
      tokenVersion: 0, refreshJti: null, disabled: false, createdAt: now, updatedAt: now,
    });
    await writeFile(resolve(server.dataDir, 'accounts/admin1.json'), JSON.stringify(oldAccount('admin1', 'admin_one', 'admin')));
    await writeFile(resolve(server.dataDir, 'accounts/member1.json'), JSON.stringify(oldAccount('member1', 'member_one', 'member')));

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(resolve(server.dataDir, 'entries/e1.json'), JSON.stringify({
      id: 'e1', createdAt: now, takenAt: now, uploadedAt: now, dateSource: 'manual',
      yearMonth: '2025-05', status: 'done', title: TITLE, mood: '平静', diaryText: DIARY,
      imageDescription: '海边堤坝上的落日', chat: [
        { role: 'assistant', content: '看起来是很舒服的傍晚' },
        { role: 'user', content: CHAT },
      ],
      ownerId: 'admin1', userId: 'admin1', people: [], unknownFaces: 0,
      faceScannedAt: now, relationScannedAt: now,
    }));
    await writeFile(resolve(server.dataDir, 'entries/e1.img'), jpeg);
    await writeFile(resolve(server.dataDir, 'entries/e1.thumb'), jpeg);

    await writeFile(resolve(server.dataDir, 'people/p1.json'), JSON.stringify({
      id: 'p1', name: PERSON, relation: '', relations: { admin1: '朋友' }, isUser: false,
      createdAt: now, updatedAt: now, templates: [EMBEDDING], enrolledFrom: [],
    }));
    await writeFile(resolve(server.dataDir, 'relationships/admin1__p1.json'), JSON.stringify({
      id: 'admin1__p1', a: 'admin1', b: 'p1', label: '朋友', confidence: 0.9,
      evidence: [{ entryId: 'e1', kind: 'ai', createdAt: now }], createdAt: now, updatedAt: now,
    }));
    await writeFile(resolve(server.dataDir, 'users/admin1.json'), JSON.stringify({
      profile: { personality: '安静的人', personalityUpdatedAt: now, sessionCount: 3, mood: '平静', moodUpdatedAt: now },
      memories: [{ id: 'm1', text: MEMORY_TEXT, category: 'preference', createdAt: now, sourceEntryId: 'e1' }],
    }));
    await writeFile(resolve(server.dataDir, 'monthly/2025-05-admin1.json'), JSON.stringify({
      yearMonth: '2025-05', text: MONTHLY, generatedAt: now,
    }));

    await server.restart();

    // login provisions keys, creates the migrated family key, kicks the lazy sweep
    const login = await json(server.base, '/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ username: 'admin_one', password: 'password123' }),
    });
    assert.equal(login.response.status, 200);
    // first login after the upgrade issues a one-shot recovery code
    assert.match(login.body.recoveryCode, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
    assert.equal(login.body.user.accountType, 'family');
    assert.ok(login.body.user.familyId);
    const admin = auth(login.body.accessToken);

    // wait until the lazy encryption sweep reports done
    let pending = true;
    for (let i = 0; i < 100 && pending; i++) {
      const me = await json(server.base, '/api/v1/auth/me', { headers: admin });
      pending = me.body.migrationPending !== false;
      if (pending) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(pending, false, 'migration did not finish');

    // API equivalence after encryption
    const entry = await json(server.base, '/api/v1/entries/e1', { headers: admin });
    assert.equal(entry.body.title, TITLE);
    assert.equal(entry.body.diaryText, DIARY);
    assert.equal(entry.body.chat.at(-1).content, CHAT);
    const media = await fetch(`${server.base}/api/v1/entries/e1/media/image`, { headers: admin });
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), jpeg);

    const people = await json(server.base, '/api/v1/people', { headers: admin });
    const p1 = people.body.items.find((p: { id: string }) => p.id === 'p1');
    assert.equal(p1.name, PERSON);
    assert.equal(p1.relation, '朋友');
    assert.equal(p1.templateCount, 1);

    const graph = await json(server.base, '/api/v1/graph', { headers: admin });
    assert.ok(graph.body.edges.some((e: { label: string }) => e.label === '朋友'));

    const profile = await json(server.base, '/api/v1/me/profile', { headers: admin });
    assert.equal(profile.body.memories[0].text, MEMORY_TEXT);

    const monthly = await json(server.base, '/api/v1/monthly/2025-05', { headers: admin });
    assert.equal(monthly.body.text, MONTHLY);

    // member's first login joins the same migrated family and gets the FK grant
    const memberLogin = await json(server.base, '/api/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ username: 'member_one', password: 'password123' }),
    });
    assert.equal(memberLogin.response.status, 200);
    assert.equal(memberLogin.body.user.familyId, login.body.user.familyId);
    assert.equal(memberLogin.body.user.accountType, 'personal');
    const member = auth(memberLogin.body.accessToken);
    const memberPeople = await json(server.base, '/api/v1/people', { headers: member });
    assert.ok(memberPeople.body.items.some((p: { name: string }) => p.name === PERSON));
    // entries stay owner-private
    assert.equal((await fetch(`${server.base}/api/v1/entries/e1`, { headers: member })).status, 404);

    // disk is ciphertext once the scope sweep settles (people/relationships lag entries)
    const markers = [TITLE, DIARY, CHAT, PERSON, MEMORY_TEXT, MONTHLY, '0.13572468', '安静的人'];
    let hits: string[] = [];
    for (let i = 0; i < 100; i++) {
      hits = await scanForPlaintext([server.dataDir, server.cacheDir], markers);
      if (!hits.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(hits, [], `plaintext found on disk:\n${hits.join('\n')}`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nserver logs:\n${server.logs()}`);
  } finally {
    await server.cleanup();
  }
});

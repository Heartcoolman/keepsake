import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  analyzePrompt,
  INTERJECTION_RATE,
  chatPrompt,
  diaryPrompt,
  monthlyPrompt,
  peopleLine,
  type PeopleCtx,
} from '../prompts.ts';
import { analyzeCacheKey, hashImage, readAnalyzeCache, writeAnalyzeCache } from '../analyzeCache.ts';
import { xaiChat } from '../xai.ts';
import { MOCK_ANALYZE, MOCK_CHAT_REPLIES, MOCK_DIARY, MOCK_MONTHLY } from '../mock.ts';
import { enqueueInference } from '../inferenceQueue.ts';
import * as store from '../store.ts';
import * as people from '../people.ts';
import * as memory from '../memory.ts';
import * as accounts from '../accounts.ts';
import * as keyring from '../keyring.ts';
import { err } from './errors.ts';
import { requireAiEntitlement, requireKeys, userRateLimit, type AppEnv } from './middleware.ts';
import { mockV1Sse, openaiSseToV1, SSE_HEADERS } from './sse.ts';

const MOCK = process.env.MOCK_AI === '1';

export const aiRoutes = new Hono<AppEnv>();

aiRoutes.use('*', requireKeys);
aiRoutes.use('/entries/:id/analyze', userRateLimit(30), requireAiEntitlement);
aiRoutes.use('/entries/:id/chat', userRateLimit(30), requireAiEntitlement);
aiRoutes.use('/entries/:id/diary', userRateLimit(30), requireAiEntitlement);
aiRoutes.use('/monthly/:yearMonth/generate', userRateLimit(10), requireAiEntitlement);

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ScenePerson = { name: string; relation: string; isSelf: boolean };

/** Non-empty array of object elements — guards trimHistory's m.role/m.content access. */
function validMessages(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => m != null && typeof m === 'object')
  );
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-16).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 2000),
  }));
}

interface RouteKeys {
  udk: Buffer;
  scopeId: string;
  scopeKey: Buffer;
}

function routeKeysOf(account: accounts.Account): RouteKeys | null {
  const udk = keyring.getUdk(account.id);
  const scopeId = accounts.scopeIdOf(account);
  const scopeKey = keyring.getScopeKey(scopeId);
  if (!udk || !scopeKey) return null;
  return { udk, scopeId, scopeKey };
}

async function loadOwnedEntry(
  id: string,
  userId: string,
  udk: Buffer,
): Promise<store.EntryMeta | undefined> {
  if (!store.validId(id)) return undefined;
  const entry = await store.getEntryDecrypted(id, udk);
  return store.isOwnedBy(entry, userId) ? entry : undefined;
}

async function resolveScenePeople(
  entry: store.EntryMeta,
  userId: string,
  keys: RouteKeys,
): Promise<ScenePerson[]> {
  if (!entry.people?.length) return [];
  const registry = await people.listPeople(keys.scopeId, keys.scopeKey);
  const out: ScenePerson[] = [];
  for (const r of entry.people.slice(0, 10)) {
    const p = registry.find((x) => x.id === r.personId);
    if (!p?.name) continue;
    out.push({ name: p.name, relation: people.relationFor(p, userId), isSelf: p.id === userId });
  }
  return out;
}

const ymd = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

// ---------- analyze: server reads stored image ----------

aiRoutes.post('/entries/:id/analyze', async (c) => {
  const userId = c.get('account').id;
  const keys = routeKeysOf(c.get('account'));
  if (!keys) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const entry = await loadOwnedEntry(c.req.param('id'), userId, keys.udk);
  if (!entry) return err(c, 'NOT_FOUND', 'entry not found');
  const body = await c.req.json<{ force?: unknown }>().catch(() => ({ force: false }));
  const force = body.force === true;

  const imageBuf = await store.readEntryBlob(entry.id, 'img', keys.udk);
  if (!imageBuf) return err(c, 'NOT_FOUND', 'image not found');
  const imageDataUrl = `data:image/jpeg;base64,${imageBuf.toString('base64')}`;

  let peopleCtx: PeopleCtx | undefined;
  try {
    if (process.env.INFERENCE_DISABLED === '1') throw new Error('inference disabled');
    const face = await import('../face.ts');
    await enqueueInference(() => face.scanEntry(entry.id, imageBuf, keys.scopeId, keys.scopeKey));
    const refreshed = await store.getEntry(entry.id);
    if (refreshed) {
      const registry = await people.listPeople(keys.scopeId, keys.scopeKey);
      const known = refreshed.people
        .map((r) => registry.find((p) => p.id === r.personId))
        .filter((p): p is people.Person => !!p)
        .map((p) => ({ name: p.name, relation: people.relationFor(p, refreshed.ownerId || refreshed.userId) }));
      peopleCtx = { known, unknownCount: refreshed.unknownFaces };
    }
  } catch (e) {
    console.warn('[v1] face scan during analyze skipped:', e);
  }

  if (MOCK) {
    await store.patchEntryContent(entry.id, {
      imageDescription: MOCK_ANALYZE.imageDescription,
      mood: MOCK_ANALYZE.mood,
    }, keys.udk).catch(() => {});
    return c.json(MOCK_ANALYZE);
  }

  const cacheKey = analyzeCacheKey(userId, hashImage(imageBuf));
  if (!force) {
    const cached = await readAnalyzeCache(cacheKey, keys.udk);
    if (cached) {
      // Persist onto the entry like the fresh-generation branch below, so a
      // cache hit doesn't leave imageDescription/mood blank for chat/diary.
      await store.patchEntryContent(entry.id, {
        imageDescription: cached.imageDescription,
        mood: cached.mood,
      }, keys.udk).catch(() => {});
      return c.json(cached);
    }
  }

  const allowInterjection = Math.random() < INTERJECTION_RATE;
  const call = (nudge?: string) =>
    xaiChat(
      {
        messages: [
          { role: 'system', content: analyzePrompt(allowInterjection, peopleCtx) + (nudge ?? '') },
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: imageDataUrl } }],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800,
        temperature: 0.8,
      },
      c.req.raw.signal,
      userId,
    );

  let lastText = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const upstream = await call(
      attempt ? '\n\n注意:上次输出不是合法 JSON。只输出 JSON 对象本身。' : undefined,
    );
    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('[v1] analyze upstream', upstream.status, detail.slice(0, 200));
      if (attempt === 0) continue;
      return err(c, 'UPSTREAM', 'upstream error');
    }
    const data = (await upstream.json()) as { choices?: { message?: { content?: string } }[] };
    lastText = data.choices?.[0]?.message?.content ?? '';
    try {
      const cleaned = lastText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const opener = String(parsed.opener ?? '');
      const imageDescription = String(parsed.imageDescription ?? '');
      const mood = String(parsed.mood ?? '');
      if (opener && imageDescription) {
        await writeAnalyzeCache(cacheKey, { opener, imageDescription, mood }, keys.udk).catch(() => {});
        // persist description/mood onto entry for subsequent chat/diary
        await store.patchEntryContent(entry.id, { imageDescription, mood }, keys.udk).catch(() => {});
        return c.json({ opener, imageDescription, mood });
      }
    } catch {
      // retry
    }
  }
  // Two attempts without valid JSON: fail loudly instead of caching/serving a
  // raw text fragment as if it were an analysis result.
  console.error('[v1] analyze produced no valid JSON after retries', lastText.slice(0, 200));
  return err(c, 'UPSTREAM', 'analyze produced no valid result');
});

// ---------- chat SSE ----------

const aiBodyLimit = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => err(c, 'PAYLOAD_TOO_LARGE', 'payload too large'),
});

aiRoutes.post('/entries/:id/chat', aiBodyLimit, async (c) => {
  const userId = c.get('account').id;
  const keys = routeKeysOf(c.get('account'));
  if (!keys) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const entry = await loadOwnedEntry(c.req.param('id'), userId, keys.udk);
  if (!entry) return err(c, 'NOT_FOUND', 'entry not found');
  const body = await c.req.json<{ messages?: unknown }>();
  if (!validMessages(body.messages)) return err(c, 'VALIDATION', 'messages required');
  const messages = body.messages;

  if (MOCK) {
    const text = MOCK_CHAT_REPLIES[Math.floor(Math.random() * MOCK_CHAT_REPLIES.length)]!;
    return mockV1Sse(text);
  }

  const data = await memory.getUserData(userId, keys.udk);
  const profile = {
    personality: data.profile.personality.slice(0, 300),
    memories: data.memories.slice(-8).map((m) => m.text),
    mood: data.profile.mood,
  };
  const me = await people.getPerson(userId, keys.scopeKey).catch(() => undefined);
  const selfName = me?.name ?? c.get('account').displayName;
  const scene = await resolveScenePeople(entry, userId, keys);
  const imageDescription = entry.imageDescription;

  const upstream = await xaiChat(
    {
      messages: [
        {
          role: 'system',
          content: chatPrompt(String(imageDescription ?? ''), scene, profile, selfName),
        },
        ...trimHistory(messages),
      ],
      stream: true,
      max_tokens: 500,
      temperature: 0.9,
    },
    c.req.raw.signal,
    userId,
  );
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    console.error('[v1] chat upstream', upstream.status, detail.slice(0, 200));
    return err(c, 'UPSTREAM', 'upstream error');
  }
  return new Response(openaiSseToV1(upstream.body), { headers: SSE_HEADERS });
});

// ---------- diary SSE ----------

aiRoutes.post('/entries/:id/diary', aiBodyLimit, async (c) => {
  const userId = c.get('account').id;
  const keys = routeKeysOf(c.get('account'));
  if (!keys) return err(c, 'E_KEYS_LOCKED', 'unlock required');
  const entry = await loadOwnedEntry(c.req.param('id'), userId, keys.udk);
  if (!entry) return err(c, 'NOT_FOUND', 'entry not found');
  const body = await c.req.json<{
    messages?: unknown;
    dateStr?: unknown;
    mood?: unknown;
  }>();
  if (!validMessages(body.messages)) return err(c, 'VALIDATION', 'messages required');
  const messages = body.messages;
  const scene = await resolveScenePeople(entry, userId, keys);
  const me = await people.getPerson(userId, keys.scopeKey).catch(() => undefined);
  const selfName = me?.name ?? c.get('account').displayName;
  const photoMood =
    typeof body.mood === 'string' && body.mood.trim()
      ? body.mood.trim().slice(0, 20)
      : (entry.mood ?? '').slice(0, 20);
  const dateStr =
    typeof body.dateStr === 'string' && body.dateStr
      ? body.dateStr
      : ymd(entry.takenAt || entry.createdAt);
  const imageDescription = entry.imageDescription;

  const persist = (diaryText: string) => {
    void memory
      .processSession(userId, keys.udk, {
        entryId: entry.id,
        imageDescription: String(imageDescription ?? '').slice(0, 12_000),
        transcript: trimHistory(messages),
        diaryText: diaryText.slice(0, 20_000),
        peopleNames: peopleLine(scene).slice(0, 1000),
      })
      .catch((e) => console.warn('[v1] processSession failed:', e));
  };

  if (MOCK) return mockV1Sse(MOCK_DIARY, persist);

  const transcript = trimHistory(messages)
    .map((m) => `${m.role === 'user' ? '我' : '朋友'}:${m.content}`)
    .join('\n');
  const textPart = `请先看照片,理解这张照片的语义(场合、在做什么、氛围、想留住的瞬间),再结合下面的备忘与聊天写日记。备忘是早期客观记录,可能不完整;以照片理解为画面底,聊天补事实。

【画面备忘】
${String(imageDescription ?? '')}

【聊天记录】
${transcript}`;

  let userContent: string | { type: string; text?: string; image_url?: { url: string } }[] =
    textPart;
  const img = await store.readEntryBlob(entry.id, 'img', keys.udk);
  if (img?.length) {
    userContent = [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.toString('base64')}` } },
      { type: 'text', text: textPart },
    ];
  }

  const upstream = await xaiChat(
    {
      messages: [
        {
          role: 'system',
          content: diaryPrompt(String(dateStr ?? ''), scene, selfName, photoMood),
        },
        { role: 'user', content: userContent },
      ],
      stream: true,
      max_tokens: 1500,
      temperature: 0.9,
    },
    c.req.raw.signal,
    userId,
  );
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    console.error('[v1] diary upstream', upstream.status, detail.slice(0, 200));
    return err(c, 'UPSTREAM', 'upstream error');
  }
  return new Response(openaiSseToV1(upstream.body, persist), { headers: SSE_HEADERS });
});

// ---------- monthly ----------

aiRoutes.get('/monthly/:yearMonth', async (c) => {
  const ym = c.req.param('yearMonth');
  const userId = c.get('account').id;
  if (!store.validYearMonth(ym)) return err(c, 'VALIDATION', 'bad yearMonth');
  const review = await store.getMonthlyReview(`${ym}-${userId}`, keyring.getUdk(userId));
  return review ? c.json(review) : err(c, 'NOT_FOUND', 'review not found');
});

aiRoutes.post('/monthly/:yearMonth/generate', async (c) => {
  const ym = c.req.param('yearMonth');
  const userId = c.get('account').id;
  const udk = keyring.getUdk(userId)!;
  if (!store.validYearMonth(ym)) return err(c, 'VALIDATION', 'bad yearMonth');
  const monthEntries = (await store.listEntriesFor(userId, udk))
    .filter((e) => e.yearMonth === ym && e.status === 'done')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!monthEntries.length) return err(c, 'VALIDATION', 'no entries this month');

  const persist = (text: string) =>
    store.putMonthlyReview(`${ym}-${userId}`, {
      yearMonth: ym,
      text: text.trim(),
      generatedAt: Date.now(),
    }, udk);

  if (MOCK) return mockV1Sse(MOCK_MONTHLY, persist);

  const material = monthEntries
    .slice(-60)
    .map((e) => `【${ymd(e.createdAt)}】《${e.title}》(${e.mood})\n${e.diaryText.slice(0, 4000)}`)
    .join('\n\n')
    .slice(0, 100_000);
  const upstream = await xaiChat(
    {
      messages: [
        { role: 'system', content: monthlyPrompt(ym) },
        { role: 'user', content: material },
      ],
      stream: true,
      max_tokens: 1200,
      temperature: 0.85,
    },
    c.req.raw.signal,
    userId,
  );
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    console.error('[v1] monthly upstream', upstream.status, detail.slice(0, 200));
    return err(c, 'UPSTREAM', 'upstream error');
  }
  return new Response(openaiSseToV1(upstream.body, persist), { headers: SSE_HEADERS });
});

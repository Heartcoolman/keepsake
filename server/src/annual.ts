/** Annual-book generation: aggregate one year of a user's memories into an A5 PDF.
 *
 *  Everything is derived from decrypted content, so it only runs behind requireKeys,
 *  and the finished PDF lives in RAM (per account+year, short TTL) — never on disk.
 *  The AI preface is best-effort: an upstream failure degrades to a book without it. */
import { PDFDocument } from 'pdf-lib';
import * as store from './store.ts';
import * as people from './people.ts';
import { xaiChat } from './xai.ts';
import { LABELS, timed } from './perf.ts';
import {
  backPage,
  coverPage,
  excerpt,
  monthPage,
  peoplePage,
  prefacePage,
  statsPage,
  type MonthData,
} from './exports/render.ts';

const MOCK = process.env.MOCK_AI === '1';

export interface AnnualJob {
  status: 'running' | 'done';
  pdf?: Buffer;
  pages?: number;
  createdAt: number;
}

const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map<string, AnnualJob>();

function sweep(): void {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.status === 'done' && now - j.createdAt > JOB_TTL_MS) jobs.delete(k);
}

export function jobKey(accountId: string, year: number): string {
  return `${accountId}:${year}`;
}

export function getJob(accountId: string, year: number): AnnualJob | undefined {
  sweep();
  return jobs.get(jobKey(accountId, year));
}

export function startJob(accountId: string, year: number): boolean {
  sweep();
  const key = jobKey(accountId, year);
  if (jobs.get(key)?.status === 'running') return false;
  jobs.set(key, { status: 'running', createdAt: Date.now() });
  return true;
}

export function finishJob(accountId: string, year: number, pdf: Buffer | null, pages = 0): void {
  const key = jobKey(accountId, year);
  if (!pdf) {
    jobs.delete(key);
    return;
  }
  jobs.set(key, { status: 'done', pdf, pages, createdAt: Date.now() });
}

/** Counts only — the ops console has no business knowing whose book is rendering. */
export function jobStats(): { running: number; parked: number; parkedBytes: number } {
  sweep();
  let running = 0;
  let parked = 0;
  let parkedBytes = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running') running++;
    else {
      parked++;
      parkedBytes += j.pdf?.length ?? 0;
    }
  }
  return { running, parked, parkedBytes };
}

/** Date labels on cards and book pages must match the date the apps show for the same
 *  memory. The container clock is UTC, so the zone is explicit (APP_TZ) rather than
 *  whatever the process happens to run in — otherwise anything before 08:00 local is
 *  stamped a day early. */
const YMD = new Intl.DateTimeFormat('en-US', {
  timeZone: process.env.APP_TZ || 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

export function ymdCn(ts: number): string {
  const p = new Map(YMD.formatToParts(ts).map((x) => [x.type, x.value]));
  return `${p.get('year')} 年 ${Number(p.get('month'))} 月 ${Number(p.get('day'))} 日`;
}

const PREFACE_SYSTEM =
  'You are 念念, the user\'s warm memory companion in the 念想 app. ' +
  'Write the preface (卷首语) for the user\'s annual memory book, in Simplified Chinese, ' +
  'second person (「你」), under 280 characters, no headings, no lists, no emoji. ' +
  'Ground it in the concrete details from the material — named months, people, moments — ' +
  'and end looking gently toward the coming year. Output the preface text only.';

const MOCK_PREFACE =
  '这一年,你把一段段日子交给了我。有些照片你只看了一眼,有些你反复讲了很多次——' +
  '我都替你收着。翻开这本册子的时候,别急,一页一页来,就像那些日子本来的样子。' +
  '新的一年,继续把想留住的交给我吧。';

export interface AnnualSource {
  accountId: string;
  displayName: string;
  scopeId: string;
  udk: Buffer;
  scopeKey: Buffer | undefined;
  year: number;
}

export interface AnnualProgress {
  step: number;
  total: number;
  label: string;
}

/** Collect the year's entries — the cheap pre-check routes use before streaming. */
export async function yearEntries(source: AnnualSource): Promise<store.EntryMeta[]> {
  const all = await store.listEntriesFor(source.accountId, source.udk, source.scopeKey);
  return all
    .filter((e) => e.yearMonth.startsWith(`${source.year}-`))
    .sort((a, b) => a.takenAt - b.takenAt);
}

async function prefaceText(
  source: AnnualSource,
  entries: store.EntryMeta[],
  topPeople: { name: string; count: number }[],
  signal: AbortSignal,
): Promise<string | null> {
  if (MOCK) return MOCK_PREFACE;
  const byMonth = new Map<number, store.EntryMeta[]>();
  for (const e of entries) {
    const m = Number(e.yearMonth.slice(5));
    byMonth.set(m, [...(byMonth.get(m) ?? []), e]);
  }
  const monthLines = [...byMonth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, list]) => {
      const titles = list.filter((e) => e.title).slice(0, 3).map((e) => `《${excerpt(e.title, 12)}》`);
      return `${m}月: ${list.length} 段回忆${titles.length ? `,如 ${titles.join('、')}` : ''}`;
    });
  const diaryBits = entries
    .filter((e) => e.diaryText)
    .slice(0, 10)
    .map((e) => `- ${excerpt(e.diaryText, 60)}`);
  const material = [
    `年份: ${source.year}`,
    `全年 ${entries.length} 段回忆,${entries.filter((e) => e.diaryText).length} 篇日记`,
    topPeople.length ? `常出现的人: ${topPeople.map((p) => p.name).join('、')}` : '',
    ...monthLines,
    diaryBits.length ? '一些日记片段:' : '',
    ...diaryBits,
  ].filter(Boolean).join('\n').slice(0, 20_000);
  try {
    const res = await xaiChat(
      {
        messages: [
          { role: 'system', content: PREFACE_SYSTEM },
          { role: 'user', content: material },
        ],
        stream: false,
        max_tokens: 700,
      },
      signal,
      source.accountId,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function resolveNames(source: AnnualSource): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!source.scopeKey) return names;
  try {
    for (const p of await people.listPeople(source.scopeId, source.scopeKey))
      if (p.name) names.set(p.id, p.name);
  } catch {
    /* people library unavailable — book simply omits names */
  }
  return names;
}

/** Build the whole book. Emits progress per page; honours the abort signal between
 *  pages so a dropped client stops burning CPU. Returns the PDF bytes. */
export function generateAnnual(
  source: AnnualSource,
  signal: AbortSignal,
  onProgress: (p: AnnualProgress) => void,
): Promise<{ pdf: Buffer; pages: number; prefaceUsedAi: boolean }> {
  return timed(LABELS.exportAnnual, () => generateAnnualImpl(source, signal, onProgress));
}

async function generateAnnualImpl(
  source: AnnualSource,
  signal: AbortSignal,
  onProgress: (p: AnnualProgress) => void,
): Promise<{ pdf: Buffer; pages: number; prefaceUsedAi: boolean }> {
  const entries = await yearEntries(source);
  if (!entries.length) throw Object.assign(new Error('no entries this year'), { code: 'EMPTY_YEAR' });

  const names = await resolveNames(source);
  const counts = new Map<string, number>();
  for (const e of entries)
    for (const ref of e.people) counts.set(ref.personId, (counts.get(ref.personId) ?? 0) + 1);
  const topPeople = [...counts.entries()]
    .map(([id, count]) => ({ name: names.get(id) ?? '', count }))
    .filter((p) => p.name)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const months = new Map<number, store.EntryMeta[]>();
  for (const e of entries) {
    const m = Number(e.yearMonth.slice(5));
    if (m >= 1 && m <= 12) months.set(m, [...(months.get(m) ?? []), e]);
  }
  const monthNumbers = [...months.keys()].sort((a, b) => a - b);
  const total = 1 + 1 + monthNumbers.length + (topPeople.length ? 1 : 0) + 1 + 1;
  let step = 0;
  const tick = (label: string) => {
    step += 1;
    onProgress({ step, total, label });
  };
  const assertAlive = () => {
    if (signal.aborted) throw Object.assign(new Error('client went away'), { code: 'ABORTED' });
  };

  const doc = await PDFDocument.create();
  const addPage = async (jpeg: Buffer) => {
    const img = await doc.embedJpg(jpeg);
    const page = doc.addPage([420, 595]);
    page.drawImage(img, { x: 0, y: 0, width: 420, height: 595 });
  };

  // cover — hero photo: first entry that has a diary, else the year's first
  assertAlive();
  tick('封面');
  const heroEntry = entries.find((e) => e.diaryText) ?? entries[0]!;
  const hero = await store.readEntryBlob(heroEntry.id, 'img', source.udk);
  await addPage(await coverPage(source.year, source.displayName, hero));

  // preface — best-effort AI, degrade to no page
  assertAlive();
  tick('念念的话');
  const preface = await prefaceText(source, entries, topPeople, signal);
  if (preface) await addPage(await prefacePage(source.year, preface));

  for (const m of monthNumbers) {
    assertAlive();
    tick(`${m} 月`);
    const list = months.get(m)!;
    const thumbs: Buffer[] = [];
    for (const e of list.slice(0, 6)) {
      const t = await store.readEntryBlob(e.id, 'thumb', source.udk);
      if (t) thumbs.push(t);
    }
    const review = await store.getMonthlyReview(
      `${source.year}-${String(m).padStart(2, '0')}-${source.accountId}`,
      source.udk,
    );
    const diaries = list
      .filter((e) => e.diaryText)
      .sort((a, b) => b.diaryText.length - a.diaryText.length)
      .slice(0, 2)
      .map((e) => ({ title: e.title, text: e.diaryText, dateLabel: ymdCn(e.takenAt) }));
    const data: MonthData = {
      year: source.year,
      month: m,
      reviewExcerpt: review?.text ?? '',
      thumbs,
      diaries,
      entryCount: list.length,
    };
    await addPage(await monthPage(data));
  }

  if (topPeople.length) {
    assertAlive();
    tick('这一年的人');
    await addPage(await peoplePage(source.year, topPeople));
  }

  assertAlive();
  tick('这一年的数字');
  const moodCounts = new Map<string, number>();
  for (const e of entries) if (e.mood) moodCounts.set(e.mood, (moodCounts.get(e.mood) ?? 0) + 1);
  await addPage(
    await statsPage({
      year: source.year,
      photoCount: entries.length,
      diaryCount: entries.filter((e) => e.diaryText).length,
      chatCount: entries.reduce((n, e) => n + e.chat.filter((mm) => mm.role === 'user').length, 0),
      moods: [...moodCounts.entries()]
        .map(([mood, count]) => ({ mood, count }))
        .sort((a, b) => b.count - a.count),
      firstLabel: ymdCn(entries[0]!.takenAt),
      lastLabel: ymdCn(entries[entries.length - 1]!.takenAt),
    }),
  );

  assertAlive();
  tick('封底');
  await addPage(await backPage(source.year));

  const pdf = Buffer.from(await doc.save());
  return { pdf, pages: doc.getPageCount(), prefaceUsedAi: !!preface && !MOCK };
}

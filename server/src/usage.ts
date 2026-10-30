/** Per-account AI usage metering — billing reservation only, nothing is enforced.
 *  Plaintext counters (no user content) at data/usage/<accountId>-<yearMonth>.json. */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';

export interface UsageRecord {
  accountId: string;
  yearMonth: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** count of calls whose token totals were estimated (streaming without usage) */
  estimatedCalls: number;
  updatedAt: number;
}

const DIR = fileURLToPath(new URL('../data/usage/', import.meta.url));
const enqueue = createKeyedQueue();

const ym = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

async function read(key: string): Promise<UsageRecord | null> {
  try {
    return JSON.parse(await readFile(DIR + key + '.json', 'utf8')) as UsageRecord;
  } catch {
    return null;
  }
}

export async function recordUsage(
  accountId: string,
  tokens: { promptTokens?: number; completionTokens?: number; estimated?: boolean },
): Promise<void> {
  if (!accountId) return;
  const yearMonth = ym();
  const key = `${accountId}-${yearMonth}`;
  await enqueue(key, async () => {
    const cur = (await read(key)) ?? {
      accountId,
      yearMonth,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCalls: 0,
      updatedAt: 0,
    };
    cur.calls += 1;
    cur.promptTokens += Math.max(0, Math.floor(tokens.promptTokens ?? 0));
    cur.completionTokens += Math.max(0, Math.floor(tokens.completionTokens ?? 0));
    if (tokens.estimated) cur.estimatedCalls += 1;
    cur.updatedAt = Date.now();
    await mkdir(DIR, { recursive: true });
    await writeAtomic(DIR + key + '.json', JSON.stringify(cur));
  }).catch((e) => console.warn('[usage] record failed:', e));
}

/** This account's counters for the current month, or null when it has not called yet.
 *  The quota gate reads this, so it must stay a plain disk read: no keys are involved
 *  (counters carry no user content) and it has to work before the vault is unlocked. */
export async function currentUsage(accountId: string): Promise<UsageRecord | null> {
  if (!accountId) return null;
  return read(`${accountId}-${ym()}`);
}

/** Drop one account's counters for one month (ops compensation for a misjudged gate). */
export async function resetUsage(accountId: string, yearMonth: string): Promise<boolean> {
  if (!accountId || !yearMonth) return false;
  const key = `${accountId}-${yearMonth}`;
  let existed = false;
  await enqueue(key, async () => {
    existed = (await read(key)) !== null;
    await rm(DIR + key + '.json', { force: true });
  });
  return existed;
}

/** Every usage record on disk (ops reporting). */
export async function listUsage(): Promise<UsageRecord[]> {
  let files: string[] = [];
  try {
    files = await readdir(DIR);
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const rec = await read(f.slice(0, -'.json'.length));
    if (rec) out.push(rec);
  }
  return out;
}

/** Ops purge: drop one account's usage counters. */
export async function deleteAccountUsage(accountId: string): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(`${accountId}-`) || !f.endsWith('.json')) continue;
    await enqueue(f.slice(0, -'.json'.length), () => rm(DIR + f, { force: true }));
  }
}

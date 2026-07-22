/** System panel data + manual backups. Directory walks are TTL-cached because
 *  the server is single-process — an auto-refreshing ops tab must not slow the
 *  diary down. Backups land inside the mounted data volume (data/backups/) so
 *  they survive container rebuilds; everything copied is already ciphertext. */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from '../accounts.ts';
import * as families from '../families.ts';
import * as store from '../store.ts';
import * as people from '../people.ts';
import * as keyring from '../keyring.ts';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const CACHE_DIR = fileURLToPath(new URL('../../cache/', import.meta.url));
const MODELS_DIR = fileURLToPath(new URL('../../models/', import.meta.url));
const BACKUP_DIR = DATA_DIR + 'backups/';
const BACKUP_NAME_RE = /^\d{8}-\d{6}$/;
const SNAPSHOT_TTL_MS = 60_000;
/** writeAtomic / replaceFiles transients — racing with them is normal. */
const TRANSIENT_RE = /\.(tmp|bak)$/;

interface DirUsage {
  bytes: number;
  files: number;
}

async function walkSize(dir: string, skip?: string): Promise<DirUsage> {
  const usage: DirUsage = { bytes: 0, files: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return usage;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (skip && resolve(path) === resolve(skip)) continue;
    try {
      if (entry.isDirectory()) {
        const sub = await walkSize(path, skip);
        usage.bytes += sub.bytes;
        usage.files += sub.files;
      } else {
        usage.bytes += (await stat(path)).size;
        usage.files += 1;
      }
    } catch {
      // raced with a writer
    }
  }
  return usage;
}

export interface SystemSnapshot {
  generatedAt: number;
  uptimeSeconds: number;
  rssBytes: number;
  nodeVersion: string;
  mockAi: boolean;
  inferenceDisabled: boolean;
  keyring: { unlockedAccounts: number; unlockedFamilies: number };
  counts: { accounts: number; families: number; entries: number; people: number };
  disk: Record<string, DirUsage>;
  migration: {
    accountId: string;
    username: string;
    hasCrypto: boolean;
    legacyEntries: number;
  }[];
}

let cached: { at: number; data: SystemSnapshot } | null = null;

export async function getSystemSnapshot(refresh = false): Promise<SystemSnapshot> {
  if (!refresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;

  const disk: Record<string, DirUsage> = {};
  for (const name of ['entries', 'people', 'relationships', 'users', 'monthly', 'accounts', 'families', 'invites', 'usage', 'ops']) {
    disk[`data/${name}`] = await walkSize(DATA_DIR + name);
  }
  for (const name of ['analyze', 'depth', 'face', 'faceThumb']) {
    disk[`cache/${name}`] = await walkSize(CACHE_DIR + name);
  }
  disk['models'] = await walkSize(MODELS_DIR);
  disk['backups'] = await walkSize(BACKUP_DIR);

  const allAccounts = await accounts.listAccounts();
  const migration = [];
  for (const account of allAccounts) {
    migration.push({
      accountId: account.id,
      username: account.username,
      hasCrypto: accounts.hasCrypto(account),
      legacyEntries: (await store.listLegacyEntryIds(account.id)).length,
    });
  }

  const data: SystemSnapshot = {
    generatedAt: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    nodeVersion: process.version,
    mockAi: process.env.MOCK_AI === '1',
    inferenceDisabled: process.env.INFERENCE_DISABLED === '1',
    keyring: keyring.stats(),
    counts: {
      accounts: allAccounts.length,
      families: await families.countFamilies(),
      entries: (await store.listEntries()).length,
      people: (await people.listScopes()).length,
    },
    disk,
    migration,
  };
  cached = { at: Date.now(), data };
  return data;
}

// ---------- backups ----------

/** Per-file tolerant copy: entries vanishing mid-walk (atomic writers) are
 *  skipped, as are their .tmp/.bak transients and the backups dir itself. */
async function copyTolerant(src: string, dest: string, skip: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    if (resolve(from) === resolve(skip)) continue;
    if (entry.isDirectory()) {
      await copyTolerant(from, join(dest, entry.name), skip);
      continue;
    }
    if (TRANSIENT_RE.test(entry.name)) continue;
    try {
      await cp(from, join(dest, entry.name));
    } catch {
      // vanished mid-backup
    }
  }
}

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: number;
}

export async function createBackup(): Promise<BackupInfo> {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dest = BACKUP_DIR + name + '/';
  await mkdir(dest, { recursive: true });
  await copyTolerant(DATA_DIR, dest + 'data/', BACKUP_DIR.slice(0, -1));
  await copyTolerant(CACHE_DIR, dest + 'cache/', BACKUP_DIR.slice(0, -1));
  const size = await walkSize(dest);
  cached = null; // disk numbers changed
  return { name, bytes: size.bytes, createdAt: d.getTime() };
}

export async function listBackups(): Promise<BackupInfo[]> {
  let names: string[] = [];
  try {
    names = await readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    const info = await stat(BACKUP_DIR + name).catch(() => null);
    if (!info?.isDirectory()) continue;
    out.push({
      name,
      bytes: (await walkSize(BACKUP_DIR + name)).bytes,
      createdAt: info.birthtimeMs || info.mtimeMs,
    });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function deleteBackup(name: string): Promise<boolean> {
  if (!BACKUP_NAME_RE.test(name)) return false;
  const info = await stat(BACKUP_DIR + name).catch(() => null);
  if (!info?.isDirectory()) return false;
  await rm(BACKUP_DIR + name, { recursive: true, force: true });
  cached = null;
  return true;
}

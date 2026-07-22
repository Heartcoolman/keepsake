/** Per-user memory bank + soft profile: data/users/<personId>.json.
 *  Mood is a fast variable (decays after 3 days); personality is a slow one.
 *
 *  PUBLIC STUB — the storage layer below is the real implementation (the public
 *  /profile routes and ops purge depend on it). What lives in the private core
 *  module is processSession: the post-diary AI orchestration that extracts
 *  memories, tracks mood and periodically re-consolidates the personality. */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createKeyedQueue } from './lib/keyedQueue.ts';
import { writeAtomic } from './lib/atomicFile.ts';
import { decryptJson, encryptJson, isEnvelope } from './crypto.ts';
import type { ChatMessage } from './store.ts';

export interface Memory {
  id: string;
  text: string;
  category: 'preference' | 'event' | 'person' | 'other';
  createdAt: number;
  sourceEntryId: string;
}

export interface UserProfile {
  personality: string;
  personalityUpdatedAt: number;
  sessionCount: number;
  mood: string;
  moodUpdatedAt: number;
}

export interface UserData {
  profile: UserProfile;
  memories: Memory[];
}

const DIR = fileURLToPath(new URL('../data/users/', import.meta.url));
const MOOD_TTL = 3 * 24 * 3600e3;
const MAX_MEMORIES = 200;
/** One shared cap for a memory's text everywhere it is stored or deduped. */
const MAX_MEMORY_TEXT = 120;

/** Serialize each user's read-modify-write operations. */
const enqueue = createKeyedQueue();

const emptyData = (): UserData => ({
  profile: { personality: '', personalityUpdatedAt: 0, sessionCount: 0, mood: '', moodUpdatedAt: 0 },
  memories: [],
});

const CATEGORIES = new Set(['preference', 'event', 'person', 'other']);

function normalizeUserData(raw: unknown): UserData {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const profileRaw = value.profile && typeof value.profile === 'object'
    ? (value.profile as Record<string, unknown>)
    : {};
  const memories = Array.isArray(value.memories)
    ? value.memories.flatMap((item): Memory[] => {
        if (!item || typeof item !== 'object') return [];
        const m = item as Record<string, unknown>;
        if (typeof m.id !== 'string' || typeof m.text !== 'string' || !m.text.trim()) return [];
        const category = CATEGORIES.has(String(m.category)) ? (String(m.category) as Memory['category']) : 'other';
        return [{
          id: m.id.slice(0, 64),
          text: m.text.trim().slice(0, MAX_MEMORY_TEXT),
          category,
          createdAt: Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) : Date.now(),
          sourceEntryId: typeof m.sourceEntryId === 'string' ? m.sourceEntryId.slice(0, 64) : '',
        }];
      }).slice(-MAX_MEMORIES)
    : [];
  return {
    profile: {
      personality: typeof profileRaw.personality === 'string' ? profileRaw.personality.slice(0, 500) : '',
      personalityUpdatedAt: Number(profileRaw.personalityUpdatedAt) || 0,
      sessionCount: Math.max(0, Number(profileRaw.sessionCount) || 0),
      mood: typeof profileRaw.mood === 'string' ? profileRaw.mood.slice(0, 20) : '',
      moodUpdatedAt: Number(profileRaw.moodUpdatedAt) || 0,
    },
    memories,
  };
}

/** The whole memory bank (LLM-derived psychological profile) is one envelope
 *  under the owner's UDK; legacy plaintext files read as-is until rewritten. */
async function readUserData(userId: string, udk: Buffer): Promise<UserData> {
  try {
    const raw = JSON.parse(await readFile(DIR + userId + '.json', 'utf8')) as Record<string, unknown>;
    if (isEnvelope(raw.enc)) return normalizeUserData(decryptJson(raw.enc, udk));
    return normalizeUserData(raw);
  } catch {
    return emptyData();
  }
}

async function writeUserData(userId: string, udk: Buffer, data: UserData): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeAtomic(DIR + userId + '.json', JSON.stringify({ enc: encryptJson(data, udk) }));
}

/** Lazy at-rest migration: rewrite a legacy plaintext bank as an envelope. */
export async function encryptUserData(userId: string, udk: Buffer): Promise<boolean> {
  return enqueue(userId, async () => {
    try {
      const raw = JSON.parse(await readFile(DIR + userId + '.json', 'utf8')) as Record<string, unknown>;
      if (isEnvelope(raw.enc)) return false;
      await writeUserData(userId, udk, normalizeUserData(raw));
      return true;
    } catch {
      return false;
    }
  });
}

/** Ops purge: remove one account's memory bank file. */
export async function deleteUserData(userId: string): Promise<void> {
  await enqueue(userId, () => rm(DIR + userId + '.json', { force: true }));
}

async function updateUserData(
  userId: string,
  udk: Buffer,
  update: (data: UserData) => void | Promise<void>,
): Promise<UserData> {
  return enqueue(userId, async () => {
    const data = await readUserData(userId, udk);
    await update(data);
    await writeUserData(userId, udk, data);
    return data;
  });
}

/** read with mood decay applied — a stale mood reads back as '' (平常) */
export async function getUserData(userId: string, udk: Buffer): Promise<UserData> {
  const data = await readUserData(userId, udk);
  if (data.profile.mood && Date.now() - data.profile.moodUpdatedAt > MOOD_TTL)
    data.profile.mood = '';
  return data;
}

export async function putUserData(userId: string, udk: Buffer, data: UserData): Promise<void> {
  // Normalize before waiting so this call persists the snapshot the caller
  // supplied, while all internal read-modify-write operations remain queued.
  const snapshot = normalizeUserData(JSON.parse(JSON.stringify(data)));
  await enqueue(userId, () => writeUserData(userId, udk, snapshot));
}

export async function deleteMemory(userId: string, udk: Buffer, memId: string): Promise<UserData> {
  return updateUserData(userId, udk, (data) => {
    data.memories = data.memories.filter((m) => m.id !== memId);
  });
}

export async function editMemory(userId: string, udk: Buffer, memId: string, text: string): Promise<UserData> {
  return updateUserData(userId, udk, (data) => {
    const m = data.memories.find((item) => item.id === memId);
    if (m) m.text = text;
  });
}

export async function editPersonality(userId: string, udk: Buffer, text: string): Promise<UserData> {
  return updateUserData(userId, udk, (data) => {
    data.profile.personality = text;
    data.profile.personalityUpdatedAt = Date.now();
  });
}

/** post-diary hook: extract memories + today's mood, consolidate personality periodically.
 *  Private core only — every caller wraps this in a .catch, so the throw degrades cleanly. */
export async function processSession(
  userId: string,
  udk: Buffer,
  ctx: {
    entryId: string;
    imageDescription: string;
    transcript: ChatMessage[];
    diaryText: string;
    peopleNames: string;
  },
): Promise<void> {
  void userId; void udk; void ctx;
  throw new Error('memory extraction is part of the private core module — not available in this build');
}

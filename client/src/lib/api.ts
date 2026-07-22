import type { FaceRef, GraphResponse, PersonDTO } from './types';
import {
  apiFetch,
  apiJson,
  errorFromResponse,
  isAuthSession,
  isAuthUser,
  setSession,
  type AuthSession,
  type AuthUser,
} from './http';

// ---------- auth ----------

export async function fetchHealth(): Promise<{
  ok: boolean;
  mock: boolean;
  bootstrapped: boolean;
  apiVersion: number;
}> {
  return apiJson('/api/v1/health', { skipAuth: true });
}

/** Auth responses that mint an account also carry a one-shot recovery code. */
export interface AuthedResult {
  session: AuthSession;
  recoveryCode?: string;
}

function toAuthedResult(data: unknown, label: string): AuthedResult {
  if (!isAuthSession(data)) throw new Error(label);
  const recoveryCode = (data as { recoveryCode?: unknown }).recoveryCode;
  return {
    session: data,
    recoveryCode: typeof recoveryCode === 'string' ? recoveryCode : undefined,
  };
}

export async function bootstrapAuth(
  username: string,
  password: string,
  displayName?: string,
  familyName?: string,
): Promise<AuthedResult> {
  const data = await apiJson<unknown>('/api/v1/auth/bootstrap', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ username, password, displayName, familyName }),
  });
  return toAuthedResult(data, '初始化响应无效');
}

export interface RegisterInput {
  accountType: 'family' | 'personal';
  username: string;
  password: string;
  displayName?: string;
  familyName?: string;
  regCode?: string;
}

export async function registerAuth(input: RegisterInput): Promise<AuthedResult> {
  const data = await apiJson<unknown>('/api/v1/auth/register', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify(input),
  });
  return toAuthedResult(data, '注册响应无效');
}

export async function loginAuth(username: string, password: string): Promise<AuthedResult> {
  const data = await apiJson<unknown>('/api/v1/auth/login', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ username, password }),
  });
  return toAuthedResult(data, '登录响应无效');
}

/** Server restarted: same session, just refill the keyring with the password. */
export async function unlockAuth(password: string): Promise<{ recoveryCode?: string }> {
  const data = await apiJson<{ ok: boolean; recoveryCode?: string }>('/api/v1/auth/unlock', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  return { recoveryCode: data.recoveryCode };
}

export async function recoverAccount(
  username: string,
  recoveryCode: string,
  newPassword: string,
): Promise<AuthedResult> {
  const data = await apiJson<unknown>('/api/v1/auth/recover', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ username, recoveryCode, newPassword }),
  });
  return toAuthedResult(data, '找回响应无效');
}

export async function regenerateRecoveryCode(currentPassword: string): Promise<string> {
  const data = await apiJson<{ recoveryCode: string }>('/api/v1/auth/me/recovery-code', {
    method: 'POST',
    body: JSON.stringify({ currentPassword }),
  });
  return data.recoveryCode;
}

export async function logoutAuth(): Promise<void> {
  await apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
}

export interface FamilySummary {
  id: string;
  name: string;
  ownerId: string;
}

export interface MeResponse {
  user: AuthUser;
  family: FamilySummary | null;
  migrationPending: boolean;
  locked: boolean;
}

export async function fetchSession(): Promise<MeResponse> {
  const data = await apiJson<{
    user: unknown;
    family?: FamilySummary | null;
    migrationPending?: boolean;
    locked?: boolean;
  }>('/api/v1/auth/me');
  if (!isAuthUser(data.user)) throw new Error('账户信息无效');
  return {
    user: data.user,
    family: data.family ?? null,
    migrationPending: data.migrationPending === true,
    locked: data.locked === true,
  };
}

export async function fetchMe(): Promise<AuthUser> {
  return (await fetchSession()).user;
}

export async function changeMyPassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = await apiJson<unknown>('/api/v1/auth/me/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!isAuthSession(session)) throw new Error('密码修改响应无效');
  setSession(session);
}

export async function fetchAccounts(): Promise<AuthUser[]> {
  return (await apiJson<{ items: AuthUser[] }>('/api/v1/users')).items;
}

// ---------- family / invites ----------

export interface FamilyInvite {
  id: string;
  inviteeId: string;
  inviteeName: string;
  createdAt: number;
}

export interface FamilyInfo {
  family: FamilySummary | null;
  members: AuthUser[];
  invites: FamilyInvite[];
}

export async function fetchFamily(): Promise<FamilyInfo> {
  return apiJson('/api/v1/family');
}

/** Family account without a family (dissolved by ops) starts a fresh one. */
export async function createFamily(name?: string): Promise<FamilySummary> {
  const data = await apiJson<{ family: FamilySummary }>('/api/v1/family', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.family;
}

export async function sendFamilyInvite(username: string): Promise<FamilyInvite> {
  return apiJson('/api/v1/family/invites', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export async function revokeFamilyInvite(id: string): Promise<void> {
  await apiJson(`/api/v1/family/invites/${id}`, { method: 'DELETE' });
}

export interface MyInvite {
  id: string;
  familyId: string;
  familyName: string;
  inviterName: string;
  createdAt: number;
}

export async function fetchMyInvites(): Promise<MyInvite[]> {
  return (await apiJson<{ items: MyInvite[] }>('/api/v1/me/invites')).items;
}

export async function acceptInvite(id: string): Promise<void> {
  await apiJson(`/api/v1/me/invites/${id}/accept`, { method: 'POST', body: '{}' });
}

export async function declineInvite(id: string): Promise<void> {
  await apiJson(`/api/v1/me/invites/${id}/decline`, { method: 'POST', body: '{}' });
}

export async function leaveFamily(): Promise<void> {
  await apiJson('/api/v1/me/family/leave', { method: 'POST', body: '{}' });
}

export async function removeFamilyMember(id: string): Promise<void> {
  await apiJson(`/api/v1/family/members/${id}`, { method: 'DELETE' });
}

// ---------- Session (canonical open / message / complete) ----------

export interface SessionOpenResponse {
  entry: import('./types').Entry;
  analysis: {
    status: 'skipped' | 'cached' | 'generated' | 'forced';
    reason: string;
  };
}

export async function sessionOpen(
  entryId: string,
  opts: { force?: boolean } = {},
  signal?: AbortSignal,
): Promise<SessionOpenResponse> {
  const res = await apiFetch(`/api/v1/entries/${entryId}/session/open`, {
    method: 'POST',
    body: JSON.stringify({ force: opts.force === true }),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, 'session open failed');
  return res.json() as Promise<SessionOpenResponse>;
}

export function sessionMessage(
  entryId: string,
  text: string,
  onText: (fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return streamV1Sse(
    `/api/v1/entries/${entryId}/session/message`,
    { text },
    onText,
    signal,
  );
}

export type SessionCompleteResult =
  /** streamed generation — `full` is the raw front-matter text fed to onText */
  | { skipped: false; full: string }
  /** idempotent skip — the server returned the finished entry as JSON; its fields are
   *  final values, NOT front-matter, so they must bypass parseDiaryStream */
  | { skipped: true; entry: { diaryText?: string; title?: string; mood?: string } };

export async function sessionComplete(
  entryId: string,
  onText: (fullText: string) => void,
  signal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<SessionCompleteResult> {
  const url = `/api/v1/entries/${entryId}/session/complete`;
  const res = await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify({ force: opts.force === true }),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, `${url} failed`);

  const ct = res.headers.get('content-type') ?? '';
  // Idempotent skip: server returns JSON {entry, skipped:true}
  if (ct.includes('application/json')) {
    const data = (await res.json()) as {
      entry?: { diaryText?: string; title?: string; mood?: string };
      skipped?: boolean;
    };
    return { skipped: true, entry: data.entry ?? {} };
  }

  if (!res.body) throw new Error(`${url} failed: empty body`);
  const full = await consumeV1SseBody(res.body, onText, url);
  return { skipped: false, full };
}

/** Parse v1 SSE body: data: {"type":"delta","text":"..."} / {"type":"done"} */
async function consumeV1SseBody(
  body: ReadableStream<Uint8Array>,
  onText: (fullText: string) => void,
  label: string,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sawDone = false;
  const onLine = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let obj: { type?: string; text?: string; message?: string };
    try {
      obj = JSON.parse(payload) as { type?: string; text?: string; message?: string };
    } catch {
      return;
    }
    if (obj.type === 'delta' && typeof obj.text === 'string') {
      full += obj.text;
      onText(full);
      return;
    }
    if (obj.type === 'done') {
      sawDone = true;
      return;
    }
    if (obj.type === 'error') throw new Error(obj.message || 'stream error');
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const line of buffer.split('\n')) onLine(line);
        buffer = '';
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
      // Keep reading after "done" so the server can finish onDone/flush before cancel.
      if (sawDone) continue;
    }
    if (!sawDone) throw new Error(`${label} stream ended before completion`);
    return full;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // closed
    }
    reader.releaseLock();
  }
}

/** Parse v1 SSE: data: {"type":"delta","text":"..."} / {"type":"done"} */
async function streamV1Sse(
  url: string,
  body: unknown,
  onText: (fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res, `${url} failed`);
  if (!res.body) throw new Error(`${url} failed: empty body`);
  return consumeV1SseBody(res.body, onText, url);
}

export interface MonthlyReview {
  yearMonth: string;
  text: string;
  generatedAt: number;
}

export async function getMonthlyReview(
  yearMonth: string,
  _userId?: string,
  signal?: AbortSignal,
): Promise<MonthlyReview | undefined> {
  const res = await apiFetch(`/api/v1/monthly/${yearMonth}`, { signal });
  return res.ok ? ((await res.json()) as MonthlyReview) : undefined;
}

export function streamMonthlyReview(
  yearMonth: string,
  _userId: string,
  onText: (fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return streamV1Sse(`/api/v1/monthly/${yearMonth}/generate`, {}, onText, signal);
}

export interface MemoryItem {
  id: string;
  text: string;
  category: 'preference' | 'event' | 'person' | 'other';
  createdAt: number;
  sourceEntryId: string;
}

export interface UserProfileData {
  profile: {
    personality: string;
    personalityUpdatedAt: number;
    sessionCount: number;
    mood: string;
    moodUpdatedAt: number;
  };
  memories: MemoryItem[];
}

export async function fetchProfile(_userId?: string): Promise<UserProfileData> {
  return apiJson('/api/v1/me/profile');
}

export async function savePersonality(_userId: string, personality: string): Promise<UserProfileData> {
  return apiJson('/api/v1/me/profile', {
    method: 'PATCH',
    body: JSON.stringify({ personality }),
  });
}

export async function editMemoryItem(
  _userId: string,
  memId: string,
  text: string,
): Promise<UserProfileData> {
  return apiJson(`/api/v1/me/memories/${memId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

export async function deleteMemoryItem(_userId: string, memId: string): Promise<UserProfileData> {
  return apiJson(`/api/v1/me/memories/${memId}`, { method: 'DELETE' });
}

export async function fetchPeople(): Promise<PersonDTO[]> {
  const data = await apiJson<{ items: PersonDTO[] }>('/api/v1/people');
  return data.items;
}

export async function createPerson(body: {
  name: string;
  relation: string;
  isUser?: boolean;
  samples?: FaceRef[];
}): Promise<PersonDTO> {
  return apiJson('/api/v1/people', { method: 'POST', body: JSON.stringify(body) });
}

export async function updatePerson(
  id: string,
  patch: { name?: string; relation?: string; isUser?: boolean; addSamples?: FaceRef[] },
): Promise<PersonDTO> {
  return apiJson(`/api/v1/people/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function mergePerson(id: string, fromId: string): Promise<PersonDTO> {
  return apiJson(`/api/v1/people/${id}/merge`, {
    method: 'POST',
    body: JSON.stringify({ fromId }),
  });
}

export async function fetchUnassignedFaces(): Promise<{ faces: FaceRef[] }[]> {
  const data = await apiJson<{ items: { faces: FaceRef[] }[] }>('/api/v1/faces/unassigned');
  return data.items;
}

export const faceThumbUrl = (entryId: string, faceIndex: number): string =>
  `/api/v1/entries/${entryId}/faces/${faceIndex}/thumb`;

export async function deletePerson(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/people/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`delete person failed: ${res.status}`);
}

export async function fetchGraph(): Promise<GraphResponse> {
  return apiJson('/api/v1/graph');
}

export async function deleteRelationship(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/relationships/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`delete relationship failed: ${res.status}`);
}

/** Incrementally parse the diary front-matter format: 标题:… / 心情:… / --- / body */
export function parseDiaryStream(raw: string): {
  title: string;
  mood: string;
  body: string;
  headerDone: boolean;
} {
  const idx = raw.indexOf('---');
  const header = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + 3).replace(/^[-\s]*\n?/, '') : '';
  const title = /标题[::]\s*(.+)/.exec(header)?.[1]?.trim() ?? '';
  const mood = /心情[::]\s*(.+)/.exec(header)?.[1]?.trim() ?? '';
  return { title, mood, body, headerDone: idx >= 0 };
}

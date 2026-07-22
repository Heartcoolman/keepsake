/** Authenticated fetch for /api/v1 — access token in localStorage, refresh token in an
 *  httpOnly cookie (`nx_refresh`, set by the server); auto-refresh once on 401. */

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  accountType?: 'family' | 'personal';
  familyId?: string | null;
  plan?: string;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

const LS_ACCESS = 'nianxiang.v1.accessToken';
/** Legacy key only: refresh tokens now live in the httpOnly `nx_refresh` cookie. The key is
 *  still read once to migrate old sessions, and purged on the next successful auth. */
const LS_REFRESH = 'nianxiang.v1.refreshToken';
const LS_USER = 'nianxiang.v1.user';

let accessToken: string | null = null;
/** In-memory only (from the latest auth response body, or the legacy localStorage value).
 *  When null we rely on the httpOnly cookie, which the server reads on /auth/refresh. */
let refreshToken: string | null = null;
let currentUser: AuthUser | null = null;
let refreshInflight: Promise<boolean> | null = null;
let authLostHandler: (() => void) | null = null;
let keysLockedHandler: (() => void) | null = null;

/** Register once from useUserStore to transition UI when refresh fails. */
export function onAuthLost(handler: (() => void) | null): void {
  authLostHandler = handler;
}

/** Register once from useUserStore: the server keyring lost this account's keys
 *  (server restart) — prompt for the password (POST /auth/unlock), no logout. */
export function onKeysLocked(handler: (() => void) | null): void {
  keysLockedHandler = handler;
}

function notifyKeysLocked(): void {
  try {
    keysLockedHandler?.();
  } catch {
    // ignore
  }
}

function notifyAuthLost(): void {
  try {
    authLostHandler?.();
  } catch {
    // ignore
  }
}

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLs(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // private mode
  }
}

export function loadSessionFromStorage(): AuthUser | null {
  accessToken = readLs(LS_ACCESS);
  refreshToken = readLs(LS_REFRESH);
  const raw = readLs(LS_USER);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      currentUser = isAuthUser(parsed) ? parsed : null;
    } catch {
      currentUser = null;
    }
  }
  return currentUser;
}

export function isAuthUser(v: unknown): v is AuthUser {
  if (typeof v !== 'object' || v === null) return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.id === 'string' &&
    typeof u.username === 'string' &&
    typeof u.displayName === 'string' &&
    (u.role === 'admin' || u.role === 'member') &&
    typeof u.disabled === 'boolean'
  );
}

/** Runtime guard for session payloads that gate access — a malformed refresh/login
 *  response must never install half a session. */
export function isAuthSession(v: unknown): v is AuthSession {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.accessToken === 'string' &&
    s.accessToken.length > 0 &&
    typeof s.refreshToken === 'string' &&
    s.refreshToken.length > 0 &&
    typeof s.expiresIn === 'number' &&
    isAuthUser(s.user)
  );
}

/** API failure carrying the HTTP status so callers can tell auth loss (401/403)
 *  apart from transient network/server errors. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Build an ApiError from a failed Response, preferring the API's {error:{message}} shape. */
export async function errorFromResponse(res: Response, label: string): Promise<ApiError> {
  let detail = '';
  let code: string | undefined;
  try {
    const body = (await res.clone().json()) as { error?: { message?: string; code?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // non-JSON error body
  }
  return new ApiError(`${label}: ${res.status}${detail ? ` ${detail}` : ''}`, res.status, code);
}

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '认证失败或登录已过期',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '对象不存在或已被删除',
  VALIDATION: '输入不合法,请检查后重试',
  CONFLICT: '操作冲突,请刷新后重试',
  RATE_LIMITED: '尝试次数过多,请稍后再试',
  PAYLOAD_TOO_LARGE: '提交内容过大',
};

/** Map a caught error to a Chinese user-facing message. Returns null when the caller
 *  must show nothing — e.g. E_KEYS_LOCKED, where the global unlock modal already
 *  takes over. */
export function friendlyError(
  e: unknown,
  fallback: string,
  overrides?: Record<string, string>,
): string | null {
  console.warn('[api] request failed', e);
  if (e instanceof TypeError) return '连不上服务器,请检查网络';
  if (e instanceof ApiError) {
    if (e.code === 'E_KEYS_LOCKED') return null;
    if (e.code && overrides?.[e.code]) return overrides[e.code];
    if (e.code && ERROR_MESSAGES[e.code]) return ERROR_MESSAGES[e.code];
    if (!e.code || e.status >= 500) return '服务器开小差了,请稍后再试';
  }
  return fallback;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getCurrentUser(): AuthUser | null {
  return currentUser;
}

export function setSession(session: AuthSession): void {
  accessToken = session.accessToken;
  refreshToken = session.refreshToken;
  currentUser = session.user;
  writeLs(LS_ACCESS, accessToken);
  // The refresh token stays in memory + httpOnly cookie; purge any legacy stored copy.
  writeLs(LS_REFRESH, null);
  writeLs(LS_USER, JSON.stringify(currentUser));
}

export function clearSession(): void {
  accessToken = null;
  refreshToken = null;
  currentUser = null;
  writeLs(LS_ACCESS, null);
  writeLs(LS_REFRESH, null);
  writeLs(LS_USER, null);
}

async function tryRefresh(): Promise<boolean> {
  // Without an in-memory/legacy token we can still refresh via the httpOnly cookie,
  // but only bother when a session plausibly exists.
  if (!refreshToken && !currentUser) return false;
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      // Migration path: send the legacy/in-memory token in the body; otherwise an empty
      // body lets the server fall back to the `nx_refresh` cookie (sent same-origin).
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });
      if (!res.ok) {
        clearSession();
        notifyAuthLost();
        return false;
      }
      const data = (await res.json()) as unknown;
      if (!isAuthSession(data)) {
        clearSession();
        notifyAuthLost();
        return false;
      }
      setSession(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

export type ApiFetchInit = RequestInit & { skipAuth?: boolean };

/** fetch with Bearer + single 401→refresh→retry */
export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  const { skipAuth, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  if (!skipAuth && accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (rest.body && !(rest.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res = await fetch(path, { ...rest, headers });
  if (res.status === 401 && !skipAuth && (refreshToken || currentUser)) {
    const ok = await tryRefresh();
    if (ok && accessToken) {
      headers.set('authorization', `Bearer ${accessToken}`);
      res = await fetch(path, { ...rest, headers });
    }
  }
  // 423 E_KEYS_LOCKED: token is fine but the server keyring is empty (restart).
  // A refresh cannot fix this — surface the unlock UI and let the caller fail.
  if (res.status === 423 && !skipAuth) {
    try {
      const body = (await res.clone().json()) as { error?: { code?: string } };
      if (body.error?.code === 'E_KEYS_LOCKED') notifyKeysLocked();
    } catch {
      // non-JSON 423 — ignore
    }
  }
  return res;
}

export async function apiJson<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await errorFromResponse(res, `${path} failed`);
  return res.json() as Promise<T>;
}

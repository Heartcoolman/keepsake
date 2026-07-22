/** Live sync: subscribes to /api/v1/entries/changes (SSE) so other devices on the same
 *  account trigger a timeline refresh here. Singleton — start/stop from the session lifecycle. */
import { apiFetch } from './http';
import { refreshEntries } from './db';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const DEBOUNCE_MS = 1000;
const DEBOUNCE_MAX_MS = 3000;

interface ChangeFrame {
  type?: 'cursor' | 'change' | 'resync' | 'ping';
  seq?: number;
}

let feedUserId: string | null = null;
let sessionActive = false;
let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let lastSeq: number | null = null;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceMaxTimer: ReturnType<typeof setTimeout> | null = null;

function clearDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (debounceMaxTimer) {
    clearTimeout(debounceMaxTimer);
    debounceMaxTimer = null;
  }
}

function fireRefresh(): void {
  clearDebounce();
  void refreshEntries({ userId: feedUserId ?? undefined });
}

/** Coalesce change events within a 1s window, but never wait more than 3s. */
function scheduleRefresh(): void {
  debounceMaxTimer ??= setTimeout(fireRefresh, DEBOUNCE_MAX_MS);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fireRefresh, DEBOUNCE_MS);
}

function scheduleReconnect(immediate: boolean): void {
  if (reconnectTimer || !sessionActive) return;
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = null;
      if (!immediate) reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      void connect();
    },
    immediate ? 0 : reconnectDelay,
  );
}

async function consumeChangeStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onLine = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let frame: ChangeFrame;
    try {
      frame = JSON.parse(payload) as ChangeFrame;
    } catch {
      return;
    }
    if (typeof frame.seq === 'number') lastSeq = frame.seq;
    if (frame.type === 'change') scheduleRefresh();
    else if (frame.type === 'resync') fireRefresh();
    // cursor / ping: seq already recorded above, nothing else to do
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const line of buffer.split('\n')) onLine(line);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // closed
    }
    reader.releaseLock();
  }
}

async function connect(): Promise<void> {
  if (!sessionActive || document.visibilityState !== 'visible' || controller) return;
  const ctrl = new AbortController();
  controller = ctrl;
  try {
    const qs = lastSeq !== null ? `?since=${lastSeq}` : '';
    const res = await apiFetch(`/api/v1/entries/changes${qs}`, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`changes stream failed: ${res.status}`);
    reconnectDelay = RECONNECT_MIN_MS;
    await consumeChangeStream(res.body);
    // Server closed cleanly (~20min rotation) — resume right away with the last seq seen.
    if (!ctrl.signal.aborted) {
      controller = null;
      scheduleReconnect(true);
    }
  } catch {
    if (!ctrl.signal.aborted) {
      controller = null;
      scheduleReconnect(false);
    }
  }
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearDebounce();
  const ctrl = controller;
  controller = null;
  ctrl?.abort();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    disconnect();
  } else if (sessionActive) {
    void connect();
    fireRefresh(); // cheap catch-up after coming back
  }
});

/** Call once a session is established (restore, login, unlock). */
export function startChangeFeed(userId: string): void {
  feedUserId = userId;
  sessionActive = true;
  lastSeq = null;
  reconnectDelay = RECONNECT_MIN_MS;
  if (document.visibilityState === 'visible') void connect();
}

/** Call on logout / forced re-login. */
export function stopChangeFeed(): void {
  sessionActive = false;
  feedUserId = null;
  disconnect();
}

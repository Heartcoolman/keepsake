/** Authenticated media as reference-counted blob object URLs (for <img src>). */
import { apiFetch } from './http';

export function mediaPath(entryId: string, kind: 'image' | 'thumb'): string {
  return `/api/v1/entries/${entryId}/media/${kind}`;
}

interface CacheEntry {
  url: string;
  refs: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();
/** Paths whose refs dropped to 0, oldest first. Bounds retained memory so the cache can't
 *  grow without limit while browsing a large library. */
const idle: string[] = [];
const MAX_IDLE = 200;

function markActive(path: string): void {
  const i = idle.indexOf(path);
  if (i >= 0) idle.splice(i, 1);
}

function evictIdle(): void {
  while (idle.length > MAX_IDLE) {
    const path = idle.shift();
    if (path === undefined) break;
    const entry = cache.get(path);
    if (entry && entry.refs === 0) {
      URL.revokeObjectURL(entry.url);
      cache.delete(path);
    }
  }
}

async function fetchToUrl(path: string): Promise<string> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`media ${path}: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Load (or reuse) a media object URL and take a reference. Pair every resolved call with
 * releaseMediaUrl(path) so idle URLs become recyclable. The network fetch is deduped and
 * intentionally never tied to a caller's AbortSignal — one unmount must not cancel a fetch
 * other consumers (or an imminent remount) are waiting on; it always completes into the cache.
 */
export async function acquireMediaUrl(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit) {
    markActive(path);
    hit.refs++;
    return hit.url;
  }
  let pending = inflight.get(path);
  if (!pending) {
    pending = fetchToUrl(path).finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  const url = await pending;
  const entry = cache.get(path);
  if (entry) {
    markActive(path);
    entry.refs++;
    return entry.url;
  }
  cache.set(path, { url, refs: 1 });
  return url;
}

/** Drop one reference; the URL becomes eligible for recycling once no one holds it. */
export function releaseMediaUrl(path: string): void {
  const entry = cache.get(path);
  if (!entry || entry.refs === 0) return;
  entry.refs--;
  if (entry.refs === 0) {
    idle.push(path);
    evictIdle();
  }
}

export function revokeAllMedia(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  inflight.clear();
  idle.length = 0;
}

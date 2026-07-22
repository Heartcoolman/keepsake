/** In-memory per-owner entry change feed for same-account multi-device sync.
 *  A bounded ring buffer backs reconnect catch-up; the cursor is a process-local
 *  sequence, so an aged-out or post-restart cursor tells the client to resync
 *  (full refetch) instead of pretending nothing was missed. */

export type ChangeKind = 'created' | 'updated' | 'deleted';

export interface ChangeEvent {
  seq: number;
  ownerId: string;
  entryId: string;
  kind: ChangeKind;
}

type Listener = (event: ChangeEvent) => void;

const RING_MAX = 512;
const ring: ChangeEvent[] = [];
let seq = 0;
const listeners = new Map<string, Set<Listener>>();

export function publish(ownerId: string, entryId: string, kind: ChangeKind): void {
  if (!ownerId) return;
  const event: ChangeEvent = { seq: ++seq, ownerId, entryId, kind };
  ring.push(event);
  if (ring.length > RING_MAX) ring.shift();
  for (const listener of listeners.get(ownerId) ?? []) {
    try {
      listener(event);
    } catch {
      // a broken subscriber must never fail the write path
    }
  }
}

export function subscribe(ownerId: string, listener: Listener): () => void {
  let set = listeners.get(ownerId);
  if (!set) listeners.set(ownerId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(ownerId);
  };
}

/** Owner's events after `cursor`, or null when the ring no longer proves
 *  continuity (unknown/aged-out/post-restart cursor) — client must resync. */
export function replaySince(ownerId: string, cursor: number): ChangeEvent[] | null {
  if (cursor > seq) return null;
  if (cursor === seq) return [];
  if (!ring.length || ring[0].seq > cursor + 1) return null;
  return ring.filter((e) => e.ownerId === ownerId && e.seq > cursor);
}

export function currentSeq(): number {
  return seq;
}

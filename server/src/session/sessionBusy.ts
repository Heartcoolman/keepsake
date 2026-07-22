/** In-memory per-entry busy lock with generation tokens.
 *  Abort/incomplete/persist-fail all release safely; late persist after abort is ignored. */
const busy = new Map<string, number>();
let nextGen = 1;

/** Acquire exclusive session work. Returns generation token, or null if busy. */
export function tryAcquireSession(entryId: string): number | null {
  if (busy.has(entryId)) return null;
  const gen = nextGen++;
  busy.set(entryId, gen);
  return gen;
}

/** Release only if still the same generation (or force when gen omitted). */
export function releaseSession(entryId: string, gen?: number): void {
  if (gen === undefined) {
    busy.delete(entryId);
    return;
  }
  if (busy.get(entryId) === gen) busy.delete(entryId);
}

export function isSessionOwner(entryId: string, gen: number): boolean {
  return busy.get(entryId) === gen;
}

export function isSessionBusy(entryId: string): boolean {
  return busy.has(entryId);
}

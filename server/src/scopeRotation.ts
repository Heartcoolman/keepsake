/** Re-key every ciphertext belonging to one family scope. Split out of the member
 *  removal flow so the login catchup can replay an interrupted rotation through
 *  exactly the same path. Every step is idempotent: each store tries the
 *  destination key before the source key, so a mixed set of already-migrated and
 *  not-yet-migrated records converges instead of throwing. */
import * as people from './people.ts';
import * as relationships from './relationships.ts';

export async function rotateScopeCiphertext(
  scopeId: string,
  oldKey: Buffer,
  newKey: Buffer,
): Promise<void> {
  await people.reencryptScope(scopeId, oldKey, newKey);
  await relationships.reencryptScope(scopeId, oldKey, newKey);
  if (process.env.INFERENCE_DISABLED !== '1') {
    const face = await import('./face.ts').catch(() => null);
    if (face) await face.reencryptScopeCaches(scopeId, oldKey, newKey);
  }
}

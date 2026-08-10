import { randomUUID } from 'node:crypto';
import { readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Replace a file only after the complete payload has been written, so readers
 *  see either the old complete file or the new complete file. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Half-written payloads from writeAtomic / replaceFiles, suffixed `.<pid>.<uuid>`.
 *  A `.tmp` is only ever a partial copy of something being written, so a stranded
 *  one is pure garbage — it can never be the last copy of a record. */
const ORPHAN_TMP_RE = /\.\d+\.[0-9a-fA-F-]{36}\.tmp$/;

/** The `.bak` counterpart is deliberately NOT swept. store.replaceFiles and
 *  removeFilesAtomically rename the OLD file aside before installing the new one and
 *  keep that backup when a rollback fails — at that point it is the only surviving
 *  copy of the record. Deleting it to stop a crashed migration from stranding
 *  plaintext would trade a confidentiality leak for permanent data loss, so these are
 *  reported instead: loud enough to act on, harmless if ignored. */
const ORPHAN_BAK_RE = /\.\d+\.[0-9a-fA-F-]{36}\.bak$/;

/** One-shot boot sweep: remove orphaned temp files under the given roots. Safe to
 *  run only before the server accepts requests — at that point no live write can
 *  own such a file, so every match is stranded from a previous run. */
export async function sweepOrphanTransients(roots: string[]): Promise<number> {
  let removed = 0;
  const strandedBackups: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let isDir = false;
      try {
        isDir = (await stat(path)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        await walk(path);
      } else if (ORPHAN_TMP_RE.test(name)) {
        await rm(path, { force: true }).catch(() => undefined);
        removed++;
      } else if (ORPHAN_BAK_RE.test(name)) {
        strandedBackups.push(path);
      }
    }
  };
  for (const root of roots) await walk(root);
  if (strandedBackups.length) {
    console.warn(
      `[store] ${strandedBackups.length} stranded backup file(s) from an interrupted write — ` +
        'kept because a failed rollback leaves them as the only copy of a record. Inspect and ' +
        `remove once the records are known good, e.g. ${strandedBackups[0]}`,
    );
  }
  return removed;
}

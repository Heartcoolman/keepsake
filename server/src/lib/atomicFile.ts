import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

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

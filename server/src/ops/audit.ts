/** Append-only ops audit trail: data/ops-audit.jsonl.
 *  `detail` must never carry secrets — no passwords, no registration codes. */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface AuditEntry {
  ts: number;
  opId: string;
  opUsername: string;
  action: string;
  target: string;
  detail: string;
}

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const FILE = DATA_DIR + 'ops-audit.jsonl';

let tail: Promise<void> = Promise.resolve();

export function audit(
  op: { id: string; username: string },
  action: string,
  target = '',
  detail = '',
): void {
  const entry: AuditEntry = {
    ts: Date.now(),
    opId: op.id,
    opUsername: op.username,
    action,
    target: target.slice(0, 128),
    detail: detail.slice(0, 256),
  };
  tail = tail
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(FILE, JSON.stringify(entry) + '\n');
    })
    .catch((e) => console.warn('[ops] audit write failed:', e));
}

/** Newest first. */
export async function readAuditTail(limit: number): Promise<AuditEntry[]> {
  let text = '';
  try {
    text = await readFile(FILE, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line): AuditEntry[] => {
      try {
        return [JSON.parse(line) as AuditEntry];
      } catch {
        return [];
      }
    })
    .reverse();
}

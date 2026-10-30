/** Single-instance guard over the data directory.
 *
 *  The keyring, the per-user rate-limit counters and the inference queue all live in
 *  process memory with no shared backend. A second process on the same data directory
 *  therefore does not fail loudly: it splits family keys (a rotation run by one process
 *  leaves the other holding a key it will never see revoked), voids the rate limits
 *  (each process counts only its own share) and serialises inference twice over. The
 *  symptoms are intermittent decrypt failures and limits that let more through than
 *  configured — expensive to trace back to "someone started a second replica".
 *
 *  README documents the constraint; this makes the process refuse rather than corrupt.
 *  Exclusive create (`wx`) is the portable primitive — flock is not in node:fs. A lock
 *  left by a SIGKILLed process is reclaimed by checking whether its pid is still alive. */
import { openSync, closeSync, readFileSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';

export class InstanceLockError extends Error {}

interface LockBody {
  pid: number;
  startedAt: string;
  port: number | null;
}

function readHolder(path: string): LockBody | null {
  try {
    const body = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockBody>;
    return typeof body?.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0
      ? { pid: body.pid, startedAt: String(body.startedAt ?? '?'), port: body.port ?? null }
      : null;
  } catch {
    // unreadable or truncated (crash mid-write): treat as stale rather than wedging boot
    return null;
  }
}

/** Alive means "some process holds this pid". It may not be ours after a pid wrap,
 *  which is why the message names the pid instead of asserting it is a nianxiang. */
function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = alive but owned by another user; only ESRCH proves it is gone
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function claim(path: string, port: number | null): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString(), port };
    writeSync(fd, JSON.stringify(body));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Acquires the lock or throws InstanceLockError naming the holder. Registers release
 *  on normal exit and on the signals a container runtime sends. */
export function acquireInstanceLock(dataDir: string, port: number | null = null): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = `${dataDir.replace(/\/?$/, '/')}instance.lock`;

  if (!claim(path, port)) {
    const holder = readHolder(path);
    if (holder && alive(holder.pid)) {
      throw new InstanceLockError(
        `another nianxiang process holds ${path} (pid ${holder.pid}, started ${holder.startedAt}` +
          `${holder.port ? `, port ${holder.port}` : ''}). The keyring, rate limits and the ` +
          'inference queue are process-local: a second instance on the same data directory ' +
          'splits family keys and voids rate limits. Stop the other process, or give this one ' +
          'its own data directory. If that pid is dead, delete the lock file.',
      );
    }
    // stale: the recorded pid is gone, or the file was truncated by a crash
    console.warn(
      `[lock] reclaiming stale ${path}` + (holder ? ` (pid ${holder.pid} is gone)` : ' (unreadable)'),
    );
    try {
      unlinkSync(path);
    } catch {
      /* raced with another reclaimer; the claim below decides the winner */
    }
    if (!claim(path, port)) {
      const winner = readHolder(path);
      throw new InstanceLockError(
        `lost the race for ${path} to pid ${winner?.pid ?? 'unknown'} — two processes started at once`,
      );
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // only drop it if it is still ours — never delete a lock a successor reclaimed
      if (readHolder(path)?.pid === process.pid) unlinkSync(path);
    } catch {
      /* nothing useful to do while exiting */
    }
  };

  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    // 'exit' does not run when a signal terminates the process, so release here too.
    // Re-raising after the one-shot listener is gone restores the default disposition,
    // keeping the 128+n exit code the process had before this lock existed.
    process.once(signal, () => {
      release();
      process.kill(process.pid, signal);
    });
  }
  return release;
}

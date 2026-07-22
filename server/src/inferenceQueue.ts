/** Serialize CPU-heavy image inference so a batch import cannot start unbounded work.
 *  Two priority levels reorder pending jobs only — a job already running is never
 *  preempted: 'interactive' (a live HTTP response waits on the result; default) runs
 *  before 'batch' (upload prewarm, login catchup, background rescans). */
type Job<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export type InferencePriority = 'interactive' | 'batch';

const MAX_PENDING = 128;
const highQueue: Job<unknown>[] = [];
const lowQueue: Job<unknown>[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (highQueue.length || lowQueue.length) {
      const job = (highQueue.length ? highQueue : lowQueue).shift()!;
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    draining = false;
    if (highQueue.length || lowQueue.length) void drain();
  }
}

export function enqueueInference<T>(
  run: () => Promise<T>,
  opts: { priority?: InferencePriority } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (highQueue.length + lowQueue.length >= MAX_PENDING) {
      reject(new Error('inference queue full'));
      return;
    }
    const queue = opts.priority === 'batch' ? lowQueue : highQueue;
    queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
    void drain();
  });
}

export function pendingInferenceCount(): number {
  return highQueue.length + lowQueue.length;
}

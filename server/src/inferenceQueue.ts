/** Serialize CPU-heavy image inference so a batch import cannot start unbounded work.
 *  Two priority levels reorder pending jobs only — a job already running is never
 *  preempted: 'interactive' (a live HTTP response waits on the result; default) runs
 *  before 'batch' (upload prewarm, login catchup, background rescans). */
import { LABELS, record } from './perf.ts';

type Job<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  /** enqueue time — the gap to dequeue is the queueing cost the ops panel shows */
  queuedAt: number;
};

export type InferencePriority = 'interactive' | 'batch';

const MAX_PENDING = 128;
/** The queue runs strictly one job at a time, so a single wedged ONNX call would
 *  otherwise stall every later job — interactive ones included — for the life of
 *  the process. The timeout unblocks the queue; it cannot cancel the native call
 *  already in flight, which may keep running in the background. */
const JOB_TIMEOUT_MS = Number(process.env.INFERENCE_TIMEOUT_MS) || 120_000;

const highQueue: Job<unknown>[] = [];
const lowQueue: Job<unknown>[] = [];
let draining = false;
let running = false;

function withTimeout<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`inference timed out after ${JOB_TIMEOUT_MS}ms`)),
      JOB_TIMEOUT_MS,
    );
    timer.unref();
    run().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (highQueue.length || lowQueue.length) {
      const job = (highQueue.length ? highQueue : lowQueue).shift()!;
      record(LABELS.queueWait, Date.now() - job.queuedAt);
      running = true;
      const t0 = performance.now();
      try {
        const value = await withTimeout(job.run);
        record(LABELS.queueRun, performance.now() - t0);
        job.resolve(value);
      } catch (error) {
        record(LABELS.queueRun, performance.now() - t0, false);
        job.reject(error);
      } finally {
        running = false;
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
    queue.push({ run, resolve: resolve as (value: unknown) => void, reject, queuedAt: Date.now() });
    void drain();
  });
}

export function pendingInferenceCount(): number {
  return highQueue.length + lowQueue.length;
}

export function queueStats(): {
  pendingInteractive: number;
  pendingBatch: number;
  running: boolean;
  maxPending: number;
  timeoutMs: number;
} {
  return {
    pendingInteractive: highQueue.length,
    pendingBatch: lowQueue.length,
    running,
    maxPending: MAX_PENDING,
    timeoutMs: JOB_TIMEOUT_MS,
  };
}

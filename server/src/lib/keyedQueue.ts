/** Shared per-key promise queue: serialize read-modify-write operations on one
 *  logical record. Each module creates its own queue instance so keys never
 *  collide across stores. */

type AsyncTask<T> = () => T | Promise<T>;

export type KeyedQueue = <T>(key: string, task: AsyncTask<T>) => Promise<T>;

export function createKeyedQueue(): KeyedQueue {
  const queues = new Map<string, Promise<void>>();
  return function enqueue<T>(key: string, task: AsyncTask<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(key, tail);

    const run = previous.then(
      () => task(),
      () => task(),
    );
    // Both handlers resolve the cleanup promise, so a rejected task does not
    // create an unhandled rejection in the queue bookkeeping.
    void run.then(
      () => {
        if (queues.get(key) === tail) queues.delete(key);
        release();
      },
      () => {
        if (queues.get(key) === tail) queues.delete(key);
        release();
      },
    );
    return run;
  };
}

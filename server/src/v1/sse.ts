import { SSE_HEADERS } from '../sse.ts';

export { SSE_HEADERS };

const encoder = new TextEncoder();

/** Emit one v1 SSE frame: data: {"type":"..."}\\n\\n */
export function v1Frame(obj: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export type SseHandlers = {
  /** Called once when upstream completes with [DONE], before the done frame. */
  onComplete?: (fullText: string) => void | Promise<void>;
  /** Always called once when the stream ends (success, incomplete, or cancel). */
  onSettle?: () => void | Promise<void>;
};

/**
 * Transform OpenAI-style SSE (`choices[0].delta.content` / `[DONE]`) into v1 envelope:
 *   { type: "delta", text: "<chunk>" }
 *   { type: "done" }
 *   { type: "error", code, message }
 * onComplete runs when [DONE] is seen, **before** the done frame is enqueued.
 * onSettle always runs exactly once when the transform finishes or is cancelled.
 */
export function openaiSseToV1(
  body: ReadableStream<Uint8Array>,
  onCompleteOrHandlers?:
    | ((fullText: string) => void | Promise<void>)
    | SseHandlers,
): ReadableStream<Uint8Array> {
  const handlers: SseHandlers =
    typeof onCompleteOrHandlers === 'function'
      ? { onComplete: onCompleteOrHandlers }
      : onCompleteOrHandlers ?? {};

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sawDone = false;
  let completed = false;
  let settled = false;

  const settle = async () => {
    if (settled) return;
    settled = true;
    try {
      if (handlers.onSettle) await handlers.onSettle();
    } catch (e) {
      console.error('[sse-v1] onSettle failed', e);
    }
  };

  const complete = async () => {
    if (completed) return;
    completed = true;
    try {
      if (handlers.onComplete) await handlers.onComplete(full);
    } catch (e) {
      console.error('[sse-v1] onComplete failed', e);
    }
  };

  const consumeLine = async (
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      sawDone = true;
      await complete();
      await settle();
      controller.enqueue(v1Frame({ type: 'done' }));
      return;
    }
    try {
      const obj = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        controller.enqueue(v1Frame({ type: 'delta', text: delta }));
      }
    } catch {
      // ignore malformed upstream frames
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) await consumeLine(line, controller);
      },
      async flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          for (const line of buffer.split('\n')) await consumeLine(line, controller);
          buffer = '';
        }
        if (!sawDone) {
          controller.enqueue(
            v1Frame({
              type: 'error',
              code: 'UPSTREAM',
              message: 'upstream stream ended before completion',
            }),
          );
          await settle();
          return;
        }
        // [DONE] path already completed+settled; belt-and-suspenders if sawDone via partial
        await complete();
        await settle();
      },
      async cancel() {
        await settle();
      },
    }),
  );
}

/** Mock / synthetic v1 stream of plain text as delta frames. */
export function mockV1Sse(
  text: string,
  onCompleteOrHandlers?:
    | ((fullText: string) => void | Promise<void>)
    | SseHandlers,
  chunkSize = 6,
  delayMs = 40,
): Response {
  const handlers: SseHandlers =
    typeof onCompleteOrHandlers === 'function'
      ? { onComplete: onCompleteOrHandlers }
      : onCompleteOrHandlers ?? {};

  let cancelled = false;
  let settled = false;
  const settle = async () => {
    if (settled) return;
    settled = true;
    try {
      if (handlers.onSettle) await handlers.onSettle();
    } catch (e) {
      console.error('[sse-v1] mock onSettle failed', e);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        if (cancelled) {
          await settle();
          return;
        }
        try {
          controller.enqueue(v1Frame({ type: 'delta', text: text.slice(i, i + chunkSize) }));
        } catch {
          await settle();
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (cancelled) {
        await settle();
        return;
      }
      try {
        if (handlers.onComplete) await handlers.onComplete(text);
      } catch (e) {
        console.error('[sse-v1] mock onComplete failed', e);
      }
      await settle();
      if (cancelled) return;
      try {
        controller.enqueue(v1Frame({ type: 'done' }));
        controller.close();
      } catch {
        // client cancelled
      }
    },
    async cancel() {
      cancelled = true;
      await settle();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

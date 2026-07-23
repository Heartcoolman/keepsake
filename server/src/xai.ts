// OpenAI-compatible chat completions. Defaults to xAI cloud; point AI_BASE_URL at any
// compatible gateway (e.g. the NAS cli-proxy-api) and AI_MODEL at a vision-capable model.
import { recordUsage } from './usage.ts';

const BASE_URL = (process.env.AI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
export const MODEL = process.env.AI_MODEL || 'grok-4.5';
// Kimi K-series pins temperature at 1.0 (explicit values are rejected) and always
// reasons before answering; low effort keeps interactive latency acceptable.
const IS_KIMI = MODEL.startsWith('kimi');

/** Rough prompt-size estimate for streaming calls (no usage object available). */
function estimateTokens(body: Record<string, unknown>): number {
  try {
    return Math.ceil(JSON.stringify(body.messages ?? '').length / 4);
  } catch {
    return 0;
  }
}

/** meterId: account to bill this call to (usage metering — billing reservation). */
export async function xaiChat(
  body: Record<string, unknown>,
  requestSignal?: AbortSignal,
  meterId?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.XAI_API_KEY) headers.authorization = `Bearer ${process.env.XAI_API_KEY}`;
  // Streaming responses can legitimately outlive any fixed deadline (long diary /
  // monthly review), and they are already tied to the client's request signal —
  // apply the hard 120s timeout only to non-streaming calls.
  const signals: AbortSignal[] = [];
  if (requestSignal) signals.push(requestSignal);
  if (body.stream !== true) signals.push(AbortSignal.timeout(120_000));
  const payload: Record<string, unknown> = { model: MODEL, ...body };
  if (IS_KIMI) {
    delete payload.temperature;
    payload.reasoning_effort ??= 'low';
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  });
  if (meterId && res.ok) {
    if (body.stream === true) {
      // The stream is consumed elsewhere — record the call with an estimate.
      void recordUsage(meterId, { promptTokens: estimateTokens(body), estimated: true });
    } else {
      void res
        .clone()
        .json()
        .then((d) => {
          const usage = (d as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
          return recordUsage(meterId, {
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            estimated: !usage,
          });
        })
        .catch(() => recordUsage(meterId, { estimated: true }));
    }
  }
  return res;
}

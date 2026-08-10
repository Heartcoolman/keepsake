// OpenAI-compatible chat completions. Defaults to xAI cloud; point AI_BASE_URL at any
// compatible gateway (e.g. the NAS cli-proxy-api) and AI_MODEL at a vision-capable model.
import { recordUsage } from './usage.ts';
import { LABELS, record } from './perf.ts';

const BASE_URL = (process.env.AI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '');
export const MODEL = process.env.AI_MODEL || 'grok-4.5';
// Kimi K-series pins temperature at 1.0 (explicit values are rejected) and always
// reasons before answering; low effort keeps interactive latency acceptable.
const IS_KIMI = MODEL.startsWith('kimi');

/** Rough prompt-size estimate for streaming calls (no usage object available).
 *  Inline images are dropped from the count — base64 length wildly overstates
 *  their token cost; flat-rate them instead. */
function estimateTokens(body: Record<string, unknown>): number {
  try {
    let images = 0;
    const s = JSON.stringify(body.messages ?? '', (_k, v: unknown) => {
      if (typeof v === 'string' && v.startsWith('data:')) {
        images++;
        return '';
      }
      return v;
    });
    return Math.ceil(s.length / 4) + images * 1024;
  } catch {
    return 0;
  }
}

/** Provider identity for the ops console. Never returns the API key — only whether
 *  one is configured — and only the host of the base URL. */
export function describeAi(): {
  model: string;
  baseUrlHost: string;
  isKimi: boolean;
  mock: boolean;
  keyConfigured: boolean;
} {
  let baseUrlHost = BASE_URL;
  try {
    baseUrlHost = new URL(BASE_URL).host;
  } catch {
    /* a malformed AI_BASE_URL is worth showing verbatim */
  }
  return {
    model: MODEL,
    baseUrlHost,
    isKimi: IS_KIMI,
    mock: process.env.MOCK_AI === '1',
    keyConfigured: Boolean(process.env.XAI_API_KEY),
  };
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
  // A streaming fetch resolves at the response headers, so its sample is time-to-first-byte,
  // not generation time — the two live under different labels for exactly that reason.
  const label = body.stream === true ? LABELS.llmStream : LABELS.llmBlocking;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  } catch (error) {
    record(label, performance.now() - t0, false);
    throw error;
  }
  record(label, performance.now() - t0, res.ok);
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

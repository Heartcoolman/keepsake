/** PUBLIC STUB — the real idempotent "ensure this photo has an opener" orchestration
 *  (face context assembly, LLM analyze, cache write-back, optimistic-lock persistence)
 *  lives in the private core module. Only the stubbed session routes import this file,
 *  so the throw below is never reached in a public build. */
import * as store from '../store.ts';

export type AnalysisStatus = 'skipped' | 'cached' | 'generated' | 'forced';
export type AnalysisReason =
  | 'already_open'
  | 'has_opener'
  | 'image_cache'
  | 'llm'
  | 'done_entry'
  | 'mock';

export interface SessionKeys {
  udk: Buffer;
  scopeId: string;
  scopeKey: Buffer;
}

export interface AnalyzeEnsureResult {
  entry: store.EntryMeta;
  analysis: { status: AnalysisStatus; reason: AnalysisReason };
  opener: string;
  imageDescription: string;
  mood: string;
}

/**
 * Idempotent ensure: skip LLM if opener exists (unless force).
 * Persists opener as chat[0] assistant + description/mood + status chatting.
 */
export async function ensureAnalyze(
  entryId: string,
  keys: SessionKeys,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<AnalyzeEnsureResult> {
  void entryId; void keys; void opts;
  throw new Error('session analyze orchestration is part of the private core module — not available in this build');
}

/** Rule-based extraction of memory dates from chat text (no LLM). */
import type { DateSource } from './types';
import { isPlausibleDate, localTs } from './photoDate';

export type ChatDateKind = 'absolute' | 'relative';

export interface ParsedChatDate {
  takenAt: number;
  kind: ChatDateKind;
}

const SEASON_MONTH: Record<string, number> = {
  春: 4,
  夏: 7,
  秋: 10,
  冬: 1,
  春天: 4,
  夏天: 7,
  秋天: 10,
  冬天: 1,
};

function midMonth(y: number, m: number): number | null {
  return localTs(y, m, 15, 12, 0, 0);
}

function parseAbsolute(text: string): ParsedChatDate | null {
  // 2019年7月16日 / 2019年07月16号
  let m = text.match(/(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const ts = localTs(Number(m[1]), Number(m[2]), Number(m[3]));
    if (ts != null) return { takenAt: ts, kind: 'absolute' };
  }

  // 2019年7月 / 2019年07月
  m = text.match(/(19\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/);
  if (m) {
    const ts = midMonth(Number(m[1]), Number(m[2]));
    if (ts != null) return { takenAt: ts, kind: 'absolute' };
  }

  // 2019年夏天 / 2019年春
  m = text.match(/(19\d{2}|20\d{2})\s*年\s*(春天|夏天|秋天|冬天|春|夏|秋|冬)/);
  if (m) {
    const month = SEASON_MONTH[m[2]!];
    if (month) {
      const y = Number(m[1]);
      // 冬 → 当年 1 月中
      const ts = midMonth(y, month);
      if (ts != null) return { takenAt: ts, kind: 'absolute' };
    }
  }

  // 2019年（单独）
  m = text.match(/(19\d{2}|20\d{2})\s*年(?!\s*\d)/);
  if (m) {
    const ts = midMonth(Number(m[1]), 7);
    if (ts != null) return { takenAt: ts, kind: 'absolute' };
  }

  // 2019-07-16 / 2019/7/16
  m = text.match(/(19\d{2}|20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const ts = localTs(Number(m[1]), Number(m[2]), Number(m[3]));
    if (ts != null) return { takenAt: ts, kind: 'absolute' };
  }

  // 2019-07
  m = text.match(/(19\d{2}|20\d{2})[-/.](\d{1,2})(?![-/.\d])/);
  if (m) {
    const ts = midMonth(Number(m[1]), Number(m[2]));
    if (ts != null) return { takenAt: ts, kind: 'absolute' };
  }

  return null;
}

function relativeYearOffset(text: string): number | null {
  if (/大前年/.test(text)) return 3;
  if (/前年/.test(text)) return 2;
  if (/去年|上年/.test(text)) return 1;
  if (/今年/.test(text)) return 0;
  return null;
}

function parseRelative(text: string, ref: number): ParsedChatDate | null {
  const yearsAgo = relativeYearOffset(text);
  if (yearsAgo == null) return null;

  const refD = new Date(ref);
  const y = refD.getFullYear() - yearsAgo;

  // 去年过年 / 前年春节 → 2 月中
  if (/过年|春节|新年/.test(text)) {
    const ts = midMonth(y, 2);
    if (ts != null) return { takenAt: ts, kind: 'relative' };
  }

  // 去年夏天 …
  const season = text.match(/(春天|夏天|秋天|冬天|春|夏|秋|冬)/);
  if (season) {
    const month = SEASON_MONTH[season[1]!];
    if (month) {
      const ts = midMonth(y, month);
      if (ts != null) return { takenAt: ts, kind: 'relative' };
    }
  }

  // 去年7月16日
  let m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const ts = localTs(y, Number(m[1]), Number(m[2]));
    if (ts != null) return { takenAt: ts, kind: 'relative' };
  }

  // 去年7月
  m = text.match(/(\d{1,2})\s*月(?!\s*\d)/);
  if (m) {
    const ts = midMonth(y, Number(m[1]));
    if (ts != null) return { takenAt: ts, kind: 'relative' };
  }

  // bare 去年 / 前年 → 同年同月中日（相对 ref）
  const ts = midMonth(y, refD.getMonth() + 1);
  if (ts != null) return { takenAt: ts, kind: 'relative' };
  return null;
}

export function parseChatDate(
  text: string,
  opts: { ref?: number } = {},
): ParsedChatDate | null {
  const ref = opts.ref ?? Date.now();
  const t = text.trim();
  if (!t) return null;

  // absolute first (more specific)
  const abs = parseAbsolute(t);
  if (abs && isPlausibleDate(new Date(abs.takenAt), ref + 24 * 60 * 60 * 1000)) return abs;

  const rel = parseRelative(t, ref);
  if (rel && isPlausibleDate(new Date(rel.takenAt), ref + 24 * 60 * 60 * 1000)) return rel;

  return null;
}

/** Absolute always wins; relative only overrides weak sources. */
export function shouldApplyChatDate(
  dateSource: DateSource | undefined,
  kind: ChatDateKind,
): boolean {
  const src = dateSource ?? 'now';
  if (kind === 'absolute') return true;
  return src === 'now' || src === 'file' || src === 'chat';
}

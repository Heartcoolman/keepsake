/** Align with client `parseDiaryStream`: 标题:… / 心情:… / --- / body */
export function parseDiary(raw: string): {
  title: string;
  mood: string;
  body: string;
  headerDone: boolean;
} {
  const idx = raw.indexOf('---');
  const header = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + 3).replace(/^[-\s]*\n?/, '') : '';
  const title = /标题[::]\s*(.+)/.exec(header)?.[1]?.trim() ?? '';
  const mood = /心情[::]\s*(.+)/.exec(header)?.[1]?.trim() ?? '';
  return { title, mood, body, headerDone: idx >= 0 };
}

/** Export rendering: share cards and annual-book pages.
 *
 *  Layering: satori lays out a transparent TEXT layer (CJK line-breaking comes from the
 *  bundled Noto fonts), resvg rasterises it with the system-font scan disabled — satori
 *  emits pure glyph paths, and the scan alone costs ~2s — and sharp composites photos
 *  underneath and encodes JPEG. Photos never travel through the SVG rasteriser.
 *
 *  Fonts are not in git; they are downloaded on first use (same pattern as the ONNX
 *  models) or pre-fetched by scripts/fetch-fonts.sh. Every entry point must check
 *  fontsReady() and fail soft when the download has not landed. */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { LABELS, timed } from '../perf.ts';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONTS = {
  serif: {
    file: 'NotoSerifCJKsc-SemiBold.otf',
    minBytes: 20_000_000,
    urls: [
      'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-SemiBold.otf',
      'https://github.com/notofonts/noto-cjk/raw/main/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-SemiBold.otf',
    ],
  },
  sans: {
    file: 'NotoSansCJKsc-Regular.otf',
    minBytes: 14_000_000,
    urls: [
      'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
      'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
    ],
  },
};

let fontCache: { serif: Buffer; sans: Buffer } | null = null;
export interface FontStatus {
  /** both faces present on disk at their expected size — an export would not download */
  ready: boolean;
  /** already parsed into memory (a first export has happened this run) */
  loaded: boolean;
  files: { name: string; present: boolean; bytes: number; minBytes: number }[];
}

/** Read-only font probe for the ops console. Deliberately does NOT call fontsReady():
 *  that would kick off a 34MB download from a panel the operator expects to be inert. */
export async function fontStatus(): Promise<FontStatus> {
  const files = await Promise.all(
    Object.values(FONTS).map(async (f) => {
      const bytes = await stat(fileURLToPath(new URL(f.file, FONT_DIR)))
        .then((s) => s.size)
        .catch(() => 0);
      return { name: f.file, present: bytes >= f.minBytes, bytes, minBytes: f.minBytes };
    }),
  );
  return { ready: files.every((f) => f.present), loaded: fontCache !== null, files };
}

/** Codepoints each face can actually draw, from its own cmap — see cmapRanges. */
let coverage: { serif: [number, number][]; sans: [number, number][] } | null = null;
let loading: Promise<boolean> | null = null;

async function loadFont(f: (typeof FONTS)[keyof typeof FONTS]): Promise<Buffer> {
  const path = fileURLToPath(new URL(f.file, FONT_DIR));
  try {
    const buf = await readFile(path);
    if (buf.length >= f.minBytes) return buf;
  } catch {
    /* not fetched yet — fall through to the download */
  }
  await mkdir(fileURLToPath(FONT_DIR), { recursive: true });
  let lastErr: unknown;
  for (const url of f.urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < f.minBytes) throw new Error(`truncated: ${buf.length} bytes`);
      await writeFile(`${path}.part`, buf);
      await rename(`${path}.part`, path);
      console.log(`[exports] font downloaded (${(buf.length / 1e6).toFixed(0)}MB) ${f.file}`);
      return buf;
    } catch (e) {
      lastErr = e;
      console.warn(`[exports] font download failed from ${new URL(url).host}:`, e);
    }
  }
  throw lastErr;
}

export async function fontsReady(): Promise<boolean> {
  if (fontCache) return true;
  loading ??= (async () => {
    const [serif, sans] = await Promise.all([loadFont(FONTS.serif), loadFont(FONTS.sans)]);
    fontCache = { serif, sans };
    coverage = { serif: cmapRanges(serif), sans: cmapRanges(sans) };
    return true;
  })();
  try {
    return await loading;
  } catch {
    loading = null; // a later request retries the download
    return false;
  }
}

/** Minimal cmap reader: the format-12 subtable (platform 3 / encoding 10) of an
 *  OpenType font as sorted codepoint ranges. Both Noto CJK faces carry one and it is
 *  a superset of their format-4 table, so nothing else needs parsing. */
function cmapRanges(font: Buffer): [number, number][] {
  let cmap = 0;
  const tables = font.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) === 'cmap') cmap = font.readUInt32BE(rec + 8);
  }
  if (!cmap) return [];
  let sub = 0;
  const encodings = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < encodings; i++) {
    const rec = cmap + 4 + i * 8;
    if (font.readUInt16BE(rec) === 3 && font.readUInt16BE(rec + 2) === 10)
      sub = cmap + font.readUInt32BE(rec + 4);
  }
  if (!sub || font.readUInt16BE(sub) !== 12) return [];
  const ranges: [number, number][] = [];
  const groups = font.readUInt32BE(sub + 12);
  for (let i = 0; i < groups; i++) {
    const g = sub + 16 + i * 12;
    ranges.push([font.readUInt32BE(g), font.readUInt32BE(g + 4)]);
  }
  return ranges;
}

function covered(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

type Node = { type: string; props: Record<string, unknown> };

/** flex div shorthand — satori requires explicit flex on every multi-child box */
export function box(style: Record<string, unknown>, children: unknown): Node {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

const PICTO = /\p{Extended_Pictographic}/u;

/** Emoji-ish codepoints, including the ones Extended_Pictographic misses: regional
 *  indicators (flags), the keycap combiner, variation selectors and ZWJ. */
function pictographic(cp: number): boolean {
  return (
    PICTO.test(String.fromCodePoint(cp)) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d ||
    cp === 0x20e3 ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff)
  );
}

export function cleanText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      out += ' ';
      continue;
    }
    // colour emoji draw as tofu in the bundled CJK faces, but the symbols those faces
    // do carry (©®™‼★☀⚠…) must survive — their own cmap is the only exact answer
    if (!pictographic(cp)) {
      out += ch;
      continue;
    }
    if (coverage && covered(coverage.serif, cp) && covered(coverage.sans, cp)) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function excerpt(s: string, max: number): string {
  const t = cleanText(s);
  // slice by codepoint — cutting UTF-16 units splits a surrogate pair into tofu
  const cps = [...t];
  return cps.length <= max ? t : `${cps.slice(0, max).join('')}…`;
}

const FONT_SET = () => [
  { name: 'NotoSerif', data: fontCache!.serif, weight: 600 as const, style: 'normal' as const },
  { name: 'NotoSans', data: fontCache!.sans, weight: 400 as const, style: 'normal' as const },
];

/** Laid-out height of a node at a given width. Zones that sharp composites against
 *  are reserved from this, never from an estimate that can disagree with the layout. */
async function measureHeight(node: Node, width: number): Promise<number> {
  const svg = await satori(node as never, { width, fonts: FONT_SET() });
  return Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0);
}

/** Rasterise a satori node; with `height` omitted the node is laid out to fit its
 *  content and the measured height comes back alongside the bitmap. */
async function textLayer(
  node: Node,
  width: number,
  height?: number,
): Promise<{ png: Buffer; height: number }> {
  const svg = await satori(node as never, {
    width,
    ...(height === undefined ? {} : { height }),
    fonts: FONT_SET(),
  });
  const png = Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
  return { png, height: height ?? Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0) };
}

async function roundedPhoto(photo: Buffer, w: number, h: number, radius: number): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" fill="#fff"/></svg>`,
  );
  return sharp(photo)
    .rotate()
    .resize(w, h, { fit: 'cover' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------- share card

export interface CardData {
  photo: Buffer;
  title: string;
  body: string;
  dateLabel: string;
  peopleLabel: string;
}

const CARD_W = 1080;
const CARD_PAD = 64;
const CARD_CONTENT = CARD_W - CARD_PAD * 2;
const BODY_SIZE = 30;
const TITLE_SIZE = 52;

export function renderCard(data: CardData): Promise<Buffer> {
  return timed(LABELS.exportCard, () => renderCardImpl(data));
}

async function renderCardImpl(data: CardData): Promise<Buffer> {
  if (!(await fontsReady())) throw new Error('export fonts missing');
  // autoOrient dimensions, not the stored ones: roundedPhoto rotates the pixels, so a
  // portrait photo tagged orientation 6 would otherwise get a landscape slot and be
  // centre-cropped to a band
  const meta = (await sharp(data.photo).metadata()).autoOrient;
  const photoH = Math.max(
    400,
    Math.min(1240, Math.round((CARD_CONTENT * (meta.height || 3)) / (meta.width || 4))),
  );

  const title = excerpt(data.title, 40);
  const body = excerpt(data.body, 200);

  const children: Node[] = [];
  if (title)
    children.push(
      box(
        {
          marginTop: 40,
          fontFamily: 'NotoSerif',
          fontSize: TITLE_SIZE,
          color: '#f7f1e8',
          lineClamp: 2,
          wordBreak: 'break-word',
        },
        title,
      ),
    );
  if (body)
    children.push(
      box(
        {
          marginTop: 24,
          lineHeight: 1.9,
          color: '#d8cfc2',
          textAlign: 'justify',
          lineClamp: 8,
          wordBreak: 'break-word',
        },
        body,
      ),
    );
  children.push(
    box({ justifyContent: 'space-between', marginTop: 36, fontSize: 26, color: '#8f8578' }, [
      box({}, cleanText([data.dateLabel, data.peopleLabel].filter(Boolean).join(' · '))),
      box({}, '念想 · Keepsake'),
    ]),
  );

  // no height: satori lays the text out to fit and reports how tall it came out, so
  // the canvas always matches the real wrapping instead of a per-glyph estimate
  const layer = await textLayer(
    box(
      {
        width: CARD_W,
        flexDirection: 'column',
        padding: `${CARD_PAD + photoH}px ${CARD_PAD}px ${CARD_PAD}px`,
        color: '#efe7dc',
        fontFamily: 'NotoSans',
        fontSize: BODY_SIZE,
      },
      children,
    ),
    CARD_W,
  );
  const H = layer.height;
  const photo = await roundedPhoto(data.photo, CARD_CONTENT, photoH, 18);
  return sharp({ create: { width: CARD_W, height: H, channels: 3, background: '#131015' } })
    .composite([
      { input: photo, top: CARD_PAD, left: CARD_PAD },
      { input: layer.png, top: 0, left: 0 },
    ])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

// ------------------------------------------------------------- annual pages

/** A5 portrait at ~210 dpi; PDF pages are 420×595pt and get this bitmap full-bleed. */
export const PAGE_W = 1240;
export const PAGE_H = 1754;
const PAGE_PAD = 96;
const PAGE_CONTENT = PAGE_W - PAGE_PAD * 2;

const PAGE_BG = '#141118';
const INK = '#efe7dc';
const INK_SOFT = '#d8cfc2';
const INK_FAINT = '#8f8578';

function pageShell(children: Node[], extra: Record<string, unknown> = {}): Node {
  return box(
    {
      width: PAGE_W,
      height: PAGE_H,
      flexDirection: 'column',
      padding: PAGE_PAD,
      backgroundColor: 'transparent',
      color: INK,
      fontFamily: 'NotoSans',
      fontSize: 30,
      ...extra,
    },
    children,
  );
}

async function renderPage(
  node: Node,
  composites: { input: Buffer; top: number; left: number }[] = [],
): Promise<Buffer> {
  if (!(await fontsReady())) throw new Error('export fonts missing');
  const layer = await textLayer(node, PAGE_W, PAGE_H);
  return sharp({ create: { width: PAGE_W, height: PAGE_H, channels: 3, background: PAGE_BG } })
    .composite([...composites, { input: layer.png, top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

export async function coverPage(
  year: number,
  displayName: string,
  hero: Buffer | null,
): Promise<Buffer> {
  const heroH = 900;
  const composites = hero
    ? [{ input: await roundedPhoto(hero, PAGE_CONTENT, heroH, 24), top: 420, left: PAGE_PAD }]
    : [];
  return renderPage(
    pageShell([
      box({ marginTop: 60, fontFamily: 'NotoSerif', fontSize: 130, color: '#f7f1e8' }, `${year}`),
      box({ marginTop: 18, fontSize: 40, color: INK_SOFT }, `${cleanText(displayName)} 的年度回忆册`),
      box({ marginTop: hero ? 900 + 300 : 320, fontSize: 28, color: INK_FAINT }, '念想 · Keepsake'),
    ]),
    composites,
  );
}

export async function prefacePage(year: number, text: string): Promise<Buffer> {
  return renderPage(
    pageShell([
      box({ fontFamily: 'NotoSerif', fontSize: 56, color: '#f7f1e8' }, '念念的话'),
      box(
        { marginTop: 56, lineHeight: 2.1, fontSize: 32, color: INK_SOFT, textAlign: 'justify', lineClamp: 18 },
        excerpt(text, 460),
      ),
      box({ marginTop: 64, justifyContent: 'flex-end', fontSize: 30, color: INK_FAINT }, `—— 念念,写于 ${year} 年末`),
    ]),
  );
}

export interface MonthData {
  year: number;
  month: number;
  reviewExcerpt: string;
  thumbs: Buffer[];
  diaries: { title: string; text: string; dateLabel: string }[];
  entryCount: number;
}

const CN_MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

export async function monthPage(data: MonthData): Promise<Buffer> {
  if (!(await fontsReady())) throw new Error('export fonts missing');
  const GAP = 20;
  const cols = 3;
  const cell = Math.floor((PAGE_CONTENT - GAP * (cols - 1)) / cols);
  const shown = Math.min(6, data.thumbs.length);
  const rows = Math.ceil(shown / cols);

  const headerChildren: Node[] = [
    box({ alignItems: 'flex-end' }, [
      box({ fontFamily: 'NotoSerif', fontSize: 64, color: '#f7f1e8' }, CN_MONTHS[data.month - 1]!),
      box({ marginLeft: 24, paddingBottom: 10, fontSize: 28, color: INK_FAINT },
        `${data.year} 年 ${data.month} 月 · ${data.entryCount} 段回忆`),
    ]),
    data.reviewExcerpt
      ? box({ marginTop: 36, lineHeight: 1.9, fontSize: 28, color: INK_SOFT, textAlign: 'justify', lineClamp: 3 },
          excerpt(data.reviewExcerpt, 130))
      : box({}, ''),
  ];
  const gridH = rows ? rows * cell + (rows - 1) * GAP : 0;

  const diaryBlocks = data.diaries.slice(0, 2).map((d) =>
    box({ flexDirection: 'column', marginTop: 44 }, [
      box({ fontFamily: 'NotoSerif', fontSize: 34, color: '#f7f1e8', lineClamp: 1 },
        `《${excerpt(d.title || '无题', 18)}》 · ${d.dateLabel}`),
      box({ marginTop: 14, lineHeight: 1.9, fontSize: 28, color: INK_SOFT, textAlign: 'justify', lineClamp: 4 },
        excerpt(d.text, 110)),
    ]),
  );

  // The photo grid is composited by sharp at absolute offsets, so the header zone is
  // measured, not guessed: a taller header pushes the grid down instead of being
  // overdrawn by it. The floor keeps the established spacing for short headers; the
  // ceiling is whatever the page has left after the grid and the diaries, so growth
  // can never run the page off its own bottom edge (the zone clips instead).
  const floor = data.reviewExcerpt ? 360 : 140;
  const [wanted, diariesH] = await Promise.all([
    measureHeight(box({ flexDirection: 'column', fontFamily: 'NotoSans', fontSize: 30 }, headerChildren), PAGE_CONTENT),
    diaryBlocks.length
      ? measureHeight(box({ flexDirection: 'column', fontFamily: 'NotoSans', fontSize: 30 }, diaryBlocks), PAGE_CONTENT)
      : Promise.resolve(0),
  ]);
  const HEADER_H = Math.min(
    Math.max(floor, wanted),
    Math.max(floor, PAGE_H - PAGE_PAD * 2 - gridH - diariesH),
  );
  const gridTop = PAGE_PAD + HEADER_H;

  const composites: { input: Buffer; top: number; left: number }[] = [];
  for (let i = 0; i < shown; i++) {
    composites.push({
      input: await roundedPhoto(data.thumbs[i]!, cell, cell, 14),
      top: gridTop + Math.floor(i / cols) * (cell + GAP),
      left: PAGE_PAD + (i % cols) * (cell + GAP),
    });
  }

  return renderPage(
    pageShell([
      box({ height: HEADER_H, flexDirection: 'column', overflow: 'hidden' }, headerChildren),
      box({ height: gridH }, ''),
      ...diaryBlocks,
    ]),
    composites,
  );
}

export async function peoplePage(
  year: number,
  people: { name: string; count: number }[],
): Promise<Buffer> {
  const max = Math.max(1, ...people.map((p) => p.count));
  const rows = people.map((p) =>
    box({ marginTop: 44, alignItems: 'center' }, [
      box({ width: 300, fontFamily: 'NotoSerif', fontSize: 40, color: '#f7f1e8', lineClamp: 1 }, excerpt(p.name, 8)),
      box({
        width: Math.max(24, Math.round((PAGE_CONTENT - 460) * (p.count / max))),
        height: 26,
        backgroundColor: '#7a5c46',
        borderRadius: 13,
      }, ''),
      box({ marginLeft: 24, fontSize: 30, color: INK_FAINT }, `${p.count} 次`),
    ]),
  );
  return renderPage(
    pageShell([
      box({ fontFamily: 'NotoSerif', fontSize: 56, color: '#f7f1e8' }, '这一年,最常出现的人'),
      box({ marginTop: 20, fontSize: 28, color: INK_FAINT }, `${year} 年照片里的他们`),
      ...rows,
    ]),
  );
}

export interface StatsData {
  year: number;
  photoCount: number;
  diaryCount: number;
  chatCount: number;
  moods: { mood: string; count: number }[];
  firstLabel: string;
  lastLabel: string;
}

export async function statsPage(s: StatsData): Promise<Buffer> {
  const stat = (n: number, label: string) =>
    box({ flexDirection: 'column', width: Math.floor(PAGE_CONTENT / 3) }, [
      box({ fontFamily: 'NotoSerif', fontSize: 96, color: '#f7f1e8' }, String(n)),
      box({ marginTop: 6, fontSize: 30, color: INK_FAINT }, label),
    ]);
  const moodRows = s.moods.slice(0, 6).map((m) =>
    box({ marginTop: 30, alignItems: 'center' }, [
      box({ width: 260, fontSize: 34, color: INK_SOFT, lineClamp: 1 }, excerpt(m.mood, 6)),
      box({ fontSize: 28, color: INK_FAINT }, `× ${m.count}`),
    ]),
  );
  return renderPage(
    pageShell([
      box({ fontFamily: 'NotoSerif', fontSize: 56, color: '#f7f1e8' }, '这一年的数字'),
      box({ marginTop: 80 }, [stat(s.photoCount, '段回忆'), stat(s.diaryCount, '篇日记'), stat(s.chatCount, '次对话')]),
      box({ marginTop: 110, fontFamily: 'NotoSerif', fontSize: 44, color: '#f7f1e8' }, '心情的颜色'),
      ...(moodRows.length ? moodRows : [box({ marginTop: 30, fontSize: 30, color: INK_FAINT }, '这一年还没有记录心情')]),
      box({ marginTop: 120, fontSize: 28, color: INK_FAINT },
        `从 ${s.firstLabel} 到 ${s.lastLabel}`),
    ]),
  );
}

export async function backPage(year: number): Promise<Buffer> {
  return renderPage(
    pageShell(
      [
        box({ fontFamily: 'NotoSerif', fontSize: 60, color: '#f7f1e8' }, '念想'),
        box({ marginTop: 16, fontSize: 30, color: INK_FAINT }, `${year} 年度回忆册 · 由念想生成`),
      ],
      { alignItems: 'center', justifyContent: 'center' },
    ),
  );
}

/** Export rendering: share cards and annual-book pages.
 *
 *  Layering: satori lays out a transparent TEXT layer (CJK line-breaking comes from the
 *  bundled Noto fonts), resvg rasterises it with the system-font scan disabled — satori
 *  emits pure glyph paths, and the scan alone costs ~2s — and sharp composites photos
 *  underneath and encodes JPEG. Photos never travel through the SVG rasteriser.
 *
 *  Fonts are fetched by scripts/fetch-fonts.sh and are not in git; every entry point
 *  must check fontsReady() and fail soft when they are missing. */
import { readFile } from 'node:fs/promises';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONT_FILES = {
  serif: new URL('NotoSerifCJKsc-SemiBold.otf', FONT_DIR),
  sans: new URL('NotoSansCJKsc-Regular.otf', FONT_DIR),
};

let fontCache: { serif: Buffer; sans: Buffer } | null = null;

export async function fontsReady(): Promise<boolean> {
  if (fontCache) return true;
  try {
    const [serif, sans] = await Promise.all([
      readFile(FONT_FILES.serif),
      readFile(FONT_FILES.sans),
    ]);
    fontCache = { serif, sans };
    return true;
  } catch {
    return false;
  }
}

type Node = { type: string; props: Record<string, unknown> };

/** flex div shorthand — satori requires explicit flex on every multi-child box */
export function box(style: Record<string, unknown>, children: unknown): Node {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

export function cleanText(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      // the bundled CJK fonts have no colour-emoji glyphs — satori would draw tofu
      .replace(/\p{Extended_Pictographic}|[\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function excerpt(s: string, max: number): string {
  const t = cleanText(s);
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Width-aware line estimate: CJK glyphs are 1em wide, latin/digits roughly 0.55em. */
function lineEstimate(text: string, fontSize: number, width: number): number {
  let w = 0;
  for (const ch of text) w += ch > '⹿' ? fontSize : fontSize * 0.55;
  return Math.max(1, Math.ceil(w / width));
}

async function textLayer(node: Node, width: number, height: number): Promise<Buffer> {
  const svg = await satori(node as never, {
    width,
    height,
    fonts: [
      { name: 'NotoSerif', data: fontCache!.serif, weight: 600, style: 'normal' },
      { name: 'NotoSans', data: fontCache!.sans, weight: 400, style: 'normal' },
    ],
  });
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
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
const BODY_LINE = Math.ceil(BODY_SIZE * 1.9);
const TITLE_SIZE = 52;

export async function renderCard(data: CardData): Promise<Buffer> {
  if (!(await fontsReady())) throw new Error('export fonts missing');
  const meta = await sharp(data.photo).rotate().metadata();
  const photoH = Math.max(
    400,
    Math.min(1240, Math.round((CARD_CONTENT * (meta.height || 3)) / (meta.width || 4))),
  );

  const title = excerpt(data.title, 40);
  const body = excerpt(data.body, 200);
  const titleLines = title ? Math.min(2, lineEstimate(title, TITLE_SIZE, CARD_CONTENT)) : 0;
  const bodyLines = body ? Math.min(8, lineEstimate(body, BODY_SIZE, CARD_CONTENT)) : 0;

  const textTop = CARD_PAD + photoH;
  const H =
    textTop +
    (titleLines ? 40 + titleLines * Math.ceil(TITLE_SIZE * 1.3) : 0) +
    (bodyLines ? 24 + bodyLines * BODY_LINE : 0) +
    36 + 40 + CARD_PAD;

  const children: Node[] = [];
  if (title)
    children.push(
      box(
        { marginTop: 40, fontFamily: 'NotoSerif', fontSize: TITLE_SIZE, color: '#f7f1e8', lineClamp: 2 },
        title,
      ),
    );
  if (body)
    children.push(
      box(
        { marginTop: 24, lineHeight: 1.9, color: '#d8cfc2', textAlign: 'justify', lineClamp: 8 },
        body,
      ),
    );
  children.push(
    box({ justifyContent: 'space-between', marginTop: 36, fontSize: 26, color: '#8f8578' }, [
      box({}, cleanText([data.dateLabel, data.peopleLabel].filter(Boolean).join(' · '))),
      box({}, '念想 · Keepsake'),
    ]),
  );

  const layer = await textLayer(
    box(
      {
        width: CARD_W,
        height: H,
        flexDirection: 'column',
        padding: `${textTop}px ${CARD_PAD}px 0`,
        color: '#efe7dc',
        fontFamily: 'NotoSans',
        fontSize: BODY_SIZE,
      },
      children,
    ),
    CARD_W,
    H,
  );
  const photo = await roundedPhoto(data.photo, CARD_CONTENT, photoH, 18);
  return sharp({ create: { width: CARD_W, height: H, channels: 3, background: '#131015' } })
    .composite([
      { input: photo, top: CARD_PAD, left: CARD_PAD },
      { input: layer, top: 0, left: 0 },
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
    .composite([...composites, { input: layer, top: 0, left: 0 }])
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
  const GAP = 20;
  const cols = 3;
  const cell = Math.floor((PAGE_CONTENT - GAP * (cols - 1)) / cols);
  const shown = Math.min(6, data.thumbs.length);
  const rows = Math.ceil(shown / cols);
  // the photo grid is composited by sharp at absolute offsets, so the text layer
  // reserves EXACT fixed-height zones — estimated heights drift and overlap
  const HEADER_H = data.reviewExcerpt ? 360 : 140;
  const gridTop = PAGE_PAD + HEADER_H;
  const gridH = rows ? rows * cell + (rows - 1) * GAP : 0;

  const composites: { input: Buffer; top: number; left: number }[] = [];
  for (let i = 0; i < shown; i++) {
    composites.push({
      input: await roundedPhoto(data.thumbs[i]!, cell, cell, 14),
      top: gridTop + Math.floor(i / cols) * (cell + GAP),
      left: PAGE_PAD + (i % cols) * (cell + GAP),
    });
  }

  const diaryBlocks = data.diaries.slice(0, 2).map((d) =>
    box({ flexDirection: 'column', marginTop: 44 }, [
      box({ fontFamily: 'NotoSerif', fontSize: 34, color: '#f7f1e8', lineClamp: 1 },
        `《${excerpt(d.title || '无题', 18)}》 · ${d.dateLabel}`),
      box({ marginTop: 14, lineHeight: 1.9, fontSize: 28, color: INK_SOFT, textAlign: 'justify', lineClamp: 4 },
        excerpt(d.text, 110)),
    ]),
  );

  return renderPage(
    pageShell([
      box({ height: HEADER_H, flexDirection: 'column', overflow: 'hidden' }, [
        box({ alignItems: 'flex-end' }, [
          box({ fontFamily: 'NotoSerif', fontSize: 64, color: '#f7f1e8' }, CN_MONTHS[data.month - 1]!),
          box({ marginLeft: 24, paddingBottom: 10, fontSize: 28, color: INK_FAINT },
            `${data.year} 年 ${data.month} 月 · ${data.entryCount} 段回忆`),
        ]),
        data.reviewExcerpt
          ? box({ marginTop: 36, lineHeight: 1.9, fontSize: 28, color: INK_SOFT, textAlign: 'justify', lineClamp: 3 },
              excerpt(data.reviewExcerpt, 130))
          : box({}, ''),
      ]),
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

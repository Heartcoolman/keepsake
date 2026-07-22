/** Infer when a photo was taken — EXIF → filename → file mtime → now. */
import exifr from 'exifr';
import type { DateSource } from './types';

const MIN_YEAR = 1990;

export function isPlausibleDate(d: Date, now = Date.now()): boolean {
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getFullYear();
  if (y < MIN_YEAR) return false;
  // allow a small clock skew into the future
  if (d.getTime() > now + 24 * 60 * 60 * 1000) return false;
  return true;
}

function fromExifDate(v: unknown, now: number): number | null {
  if (v instanceof Date) return isPlausibleDate(v, now) ? v.getTime() : null;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isPlausibleDate(d, now) ? d.getTime() : null;
  }
  return null;
}

async function fromExif(file: File, now: number): Promise<number | null> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'DateTimeDigitized', 'CreateDate', 'DateTime', 'ModifyDate'],
      reviveValues: true,
    });
    if (!tags || typeof tags !== 'object') return null;
    const t = tags as Record<string, unknown>;
    for (const key of [
      'DateTimeOriginal',
      'DateTimeDigitized',
      'CreateDate',
      'DateTime',
      'ModifyDate',
    ]) {
      const ts = fromExifDate(t[key], now);
      if (ts != null) return ts;
    }
  } catch {
    // no EXIF / unreadable
  }
  return null;
}

/** Build local timestamp from Y/M/D (and optional h/m/s). Month is 1-based. */
export function localTs(
  y: number,
  m: number,
  d: number,
  hh = 12,
  mm = 0,
  ss = 0,
): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d, hh, mm, ss);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  )
    return null;
  return isPlausibleDate(dt) ? dt.getTime() : null;
}

function fromFilename(name: string, now: number): number | null {
  const base = name.replace(/\.[^.]+$/, '');

  // IMG_20230716_143022 / Screenshot_20230716-143022 / 20230716_143022
  const compact = base.match(
    /(?:^|[^\d])(19\d{2}|20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[_-]?([01]\d|2[0-3])([0-5]\d)([0-5]\d)?)?/,
  );
  if (compact) {
    const ts = localTs(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
      compact[4] != null ? Number(compact[4]) : 12,
      compact[5] != null ? Number(compact[5]) : 0,
      compact[6] != null ? Number(compact[6]) : 0,
    );
    if (ts != null && ts <= now + 24 * 60 * 60 * 1000) return ts;
  }

  // 2023-07-16 14.30.22 / 2023_07_16 / 2023.07.16
  const dashed = base.match(
    /(?:^|[^\d])(19\d{2}|20\d{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:[ T_-]([01]\d|2[0-3])[:.]([0-5]\d)(?:[:.]([0-5]\d))?)?/,
  );
  if (dashed) {
    const ts = localTs(
      Number(dashed[1]),
      Number(dashed[2]),
      Number(dashed[3]),
      dashed[4] != null ? Number(dashed[4]) : 12,
      dashed[5] != null ? Number(dashed[5]) : 0,
      dashed[6] != null ? Number(dashed[6]) : 0,
    );
    if (ts != null && ts <= now + 24 * 60 * 60 * 1000) return ts;
  }

  return null;
}

function fromFileMtime(file: File, now: number): number | null {
  const ts = file.lastModified;
  if (!ts || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return isPlausibleDate(d, now) ? ts : null;
}

export async function resolvePhotoDate(
  file: File,
): Promise<{ takenAt: number; source: DateSource }> {
  const now = Date.now();

  const exif = await fromExif(file, now);
  if (exif != null) return { takenAt: exif, source: 'exif' };

  const named = fromFilename(file.name, now);
  if (named != null) return { takenAt: named, source: 'filename' };

  const mtime = fromFileMtime(file, now);
  if (mtime != null) return { takenAt: mtime, source: 'file' };

  return { takenAt: now, source: 'now' };
}

/** YYYY-MM-DD for <input type="date"> */
export function toDateInputValue(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse date input (local midnight → local noon for stable day display). */
export function fromDateInputValue(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return localTs(Number(m[1]), Number(m[2]), Number(m[3]), 12, 0, 0);
}

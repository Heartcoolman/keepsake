import { useEffect, useMemo } from 'react';
import { useDialog } from '../lib/useDialog';
import { useEntriesStore } from '../lib/db';
import { formatDate } from '../lib/types';
import { useReviewStore } from '../store/useReviewStore';
import { useUserStore } from '../store/useUserStore';

export function ReviewOverlay() {
  const open = useReviewStore((s) => s.open);
  const month = useReviewStore((s) => s.month);
  const text = useReviewStore((s) => s.text);
  const generatedAt = useReviewStore((s) => s.generatedAt);
  const generating = useReviewStore((s) => s.generating);
  const loaded = useReviewStore((s) => s.loaded);
  const setMonth = useReviewStore((s) => s.setMonth);
  const closeOverlay = useReviewStore((s) => s.closeOverlay);
  const generate = useReviewStore((s) => s.generate);
  const syncUser = useReviewStore((s) => s.syncUser);
  const entries = useEntriesStore((s) => s.entries);
  const uid = useUserStore((s) => s.activeUserId);

  useEffect(() => {
    if (open) syncUser(uid ?? '');
  }, [open, syncUser, uid]);

  // A review belongs to the selected person. Keep the month navigator on the
  // filtered set so changing people cannot expose a month that belongs to
  // somebody else.
  const userEntries = useMemo(
    () => (uid ? entries.filter((e) => e.userId === uid) : []),
    [entries, uid],
  );
  const months = useMemo(() => [...new Set(userEntries.map((e) => e.yearMonth))].sort(), [userEntries]);
  const displayMonth = months.length > 0 && !months.includes(month) ? months[months.length - 1]! : month;

  useEffect(() => {
    if (open && months.length > 0 && !months.includes(month)) setMonth(months[months.length - 1]!);
  }, [open, month, months, setMonth]);

  const panelRef = useDialog(open, closeOverlay);

  if (!open) return null;

  const [y, m] = displayMonth.split('-').map(Number) as [number, number];
  const idx = months.indexOf(displayMonth);
  // the review is personal — only this user's finished diaries can condense into one
  const doneCount = entries.filter(
    (e) => e.yearMonth === displayMonth && e.status === 'done' && e.userId === uid,
  ).length;

  return (
    <div className="review-overlay" onClick={closeOverlay} role="presentation">
      <div
        className="review-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-heading"
      >
        <div className="review-month-nav">
          <button
            className="icon-btn"
            aria-label="上一个月"
            disabled={idx <= 0}
            onClick={() => setMonth(months[idx - 1]!)}
          >
            ‹
          </button>
          <div className="review-month-label">
            {y}年{m}月
          </div>
          <button
            className="icon-btn"
            aria-label="下一个月"
            disabled={idx < 0 || idx >= months.length - 1}
            onClick={() => setMonth(months[idx + 1]!)}
          >
            ›
          </button>
        </div>

        <div className="review-text-area">
          <div className="review-heading" id="review-heading">✦ 这个月的你</div>
          {text ? (
            <>
              <div className="review-body">
                {text
                  .split(/\n+/)
                  .filter((p) => p.trim())
                  .map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
              </div>
              {!generating && (
                <div className="review-footer">
                  {generatedAt > 0 && <span className="review-stamp">凝聚于 {formatDate(generatedAt)}</span>}
                  <button className="review-regen" onClick={() => void generate()}>
                    ↻ 重新凝聚
                  </button>
                </div>
              )}
            </>
          ) : generating ? (
            <div className="review-hint">思绪正在沉淀…</div>
          ) : !loaded ? null : doneCount > 0 ? (
            <button className="pill-btn review-cta" onClick={() => void generate()}>
              ✦ 凝聚这个月
            </button>
          ) : (
            <div className="review-hint">这个月还没有写完的日记</div>
          )}
        </div>

        <button className="icon-btn review-close" title="关闭" onClick={closeOverlay}>
          ✕
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchAnnualFile, generateAnnualBook, type AnnualProgress } from '../lib/api';
import { useEntriesStore } from '../lib/db';
import { friendlyError } from '../lib/http';
import { useDialog } from '../lib/useDialog';
import { useAppStore } from '../store/useAppStore';

type Stage = 'idle' | 'working' | 'ready';

/** Year picker + progress for the annual memory book. Generation streams progress
 *  over SSE; the finished PDF is fetched right after and saved via a download link. */
export function AnnualBookOverlay({ onClose }: { onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const entries = useEntriesStore((s) => s.entries);
  const years = useMemo(
    () =>
      [...new Set(entries.map((e) => Number(e.yearMonth.slice(0, 4))))]
        .filter((y) => Number.isInteger(y) && y > 2000)
        .sort((a, b) => b - a),
    [entries],
  );
  const [year, setYear] = useState<number>(years[0] ?? new Date().getFullYear());
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState<AnnualProgress | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useDialog(true, onClose);

  // closing the dialog abandons the book: the stream stops, and no download or toast
  // may surface minutes later on a screen the user has already moved on from
  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    if (busyRef.current) return;
    busyRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    setStage('working');
    setProgress(null);
    try {
      await generateAnnualBook(year, setProgress, ac.signal);
      const blob = await fetchAnnualFile(year, ac.signal);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `keepsake-${year}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setStage('ready');
      showToast(`《${year} 年度回忆册》已生成并开始下载`);
    } catch (e) {
      if (ac.signal.aborted) return;
      setStage('idle');
      const msg = friendlyError(e, '年度册生成失败,请稍后再试', {
        VALIDATION: '这一年还没有回忆,换一年试试',
        CONFLICT: '这一年的册子正在生成中,稍等片刻',
        UNAVAILABLE: '服务器缺少导出字体,请联系管理员',
      });
      if (msg) showToast(msg, 'error');
    } finally {
      busyRef.current = false;
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.step / progress.total) * 100) : 0;

  return (
    // the overlay is nested inside the review overlay's own scrim — swallow the click
    // so backing out of this dialog never tears down the panel behind it
    <div
      className="share-overlay"
      onClick={(e) => {
        e.stopPropagation();
        if (stage !== 'working') onClose();
      }}
      role="presentation"
    >
      <div
        className="share-panel annual-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="年度回忆册"
      >
        <div className="annual-heading">✦ 年度回忆册</div>
        <div className="annual-sub">把一整年的照片、日记和月度回顾装订成一本 PDF 小册子。</div>

        {stage !== 'working' && (
          <div className="annual-years">
            {(years.length ? years : [year]).map((y) => (
              <button
                key={y}
                className={`pill-btn annual-year ${y === year ? 'annual-year--active' : ''}`}
                onClick={() => setYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}

        {stage === 'working' && (
          <div className="annual-progress">
            <div className="annual-progress-bar">
              <div className="annual-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="annual-progress-label">
              {progress ? `正在装订:${progress.label} (${progress.step}/${progress.total})` : '正在整理这一年…'}
            </div>
          </div>
        )}

        <div className="share-actions">
          {stage !== 'working' && (
            <button className="pill-btn" onClick={() => void generate()}>
              {stage === 'ready' ? '↻ 重新生成' : '✦ 生成并下载'}
            </button>
          )}
          <button className="pill-btn share-cancel" disabled={stage === 'working'} onClick={onClose}>
            {stage === 'working' ? '装订中…' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}

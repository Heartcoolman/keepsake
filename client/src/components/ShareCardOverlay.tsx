import { useEffect, useRef, useState } from 'react';
import { fetchExportCard } from '../lib/api';
import { friendlyError } from '../lib/http';
import { useDialog } from '../lib/useDialog';
import { useAppStore } from '../store/useAppStore';

/** Preview + download for the server-rendered share card of one memory. The card is
 *  fetched with the bearer token and held as a blob URL — same pattern as AuthImg,
 *  but never cached: content follows the diary, which the user just edited. */
export function ShareCardOverlay({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const showToast = useAppStore((s) => s.showToast);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);
  const panelRef = useDialog(true, onClose);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setUrl(null);
    setFailed(false);
    fetchExportCard(entryId, ctrl.signal)
      .then((blob) => {
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setUrl(u);
      })
      .catch((e) => {
        if (cancelled) return;
        setFailed(true);
        const msg = friendlyError(e, '分享卡生成失败,请稍后再试', {
          UNAVAILABLE: '服务器缺少导出字体,请联系管理员',
        });
        if (msg) showToast(msg, 'error');
      });
    return () => {
      cancelled = true;
      ctrl.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [entryId, showToast]);

  return (
    <div className="share-overlay" onClick={onClose} role="presentation">
      <div
        className="share-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="分享卡"
      >
        {url ? (
          <img className="share-card-img" src={url} alt="回忆分享卡" />
        ) : (
          <div className="share-hint">{failed ? '分享卡没能生成' : '念念正在为你排版…'}</div>
        )}
        <div className="share-actions">
          {url && (
            <a className="pill-btn" href={url} download={`keepsake-card-${entryId.slice(0, 8)}.jpg`}>
              ⤓ 保存图片
            </a>
          )}
          <button className="pill-btn share-cancel" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

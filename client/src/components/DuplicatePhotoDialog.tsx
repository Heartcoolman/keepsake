import { useDialog } from '../lib/useDialog';
import { useAppStore } from '../store/useAppStore';

/** Blocks addPhotos on a DUPLICATE_IMAGE response until the user picks skip or create-anyway. */
export function DuplicatePhotoDialog() {
  const pending = useAppStore((s) => s.pendingDuplicate);
  const resolveDuplicate = useAppStore((s) => s.resolveDuplicate);
  const open = !!pending;
  const skip = () => resolveDuplicate(false);
  const panelRef = useDialog(open, skip);

  if (!pending) return null;

  return (
    <div className="review-overlay" role="presentation" onClick={skip}>
      <div
        className="user-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="照片已存在"
      >
        <div className="user-heading">照片已存在</div>
        <p className="user-hint">
          「{pending.fileName}」看起来和一条已有的记忆是同一张照片,要跳过还是仍然新建一条?
        </p>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 18 }}>
          <button className="chip" onClick={skip}>
            跳过
          </button>
          <button className="pill-btn" onClick={() => resolveDuplicate(true)}>
            仍新建
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useDialog } from '../lib/useDialog';
import type { MemoryItem } from '../lib/api';
import { formatDate } from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { useProfileStore } from '../store/useProfileStore';

const CATEGORY_LABEL: Record<MemoryItem['category'], string> = {
  preference: '喜好',
  event: '经历',
  person: '牵挂',
  other: '点滴',
};

export function ProfileOverlay() {
  const open = useProfileStore((s) => s.open);
  const userId = useProfileStore((s) => s.userId);
  const data = useProfileStore((s) => s.data);
  const closeOverlay = useProfileStore((s) => s.closeOverlay);

  const [editingPersonality, setEditingPersonality] = useState<string | null>(null);
  const [editingMem, setEditingMem] = useState<{ id: string; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  useEffect(() => {
    setEditingPersonality(null);
    setEditingMem(null);
    setConfirmDel(null);
  }, [open, userId]);

  const panelRef = useDialog(open, closeOverlay);

  if (!open) return null;

  const toastFail = () => useAppStore.getState().showToast('没存上,稍后再试');

  return (
    <div className="review-overlay" onClick={closeOverlay} role="presentation">
      <div
        className="user-panel profile-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="念念眼中的你"
      >
        <div className="user-heading">✦ 念念眼中的你</div>
        {!data ? (
          <p className="people-empty">正在回想…</p>
        ) : (
          <>
            <div className="profile-section">
              <div className="profile-label">
                性格印象
                {data.profile.mood && <span className="profile-mood">最近 · {data.profile.mood}</span>}
                {editingPersonality === null && (
                  <button
                    className="icon-btn profile-edit"
                    title="编辑"
                    onClick={() => setEditingPersonality(data.profile.personality)}
                  >
                    ✎
                  </button>
                )}
              </div>
              {editingPersonality !== null ? (
                <div className="profile-edit-area">
                  <textarea
                    autoFocus
                    value={editingPersonality}
                    maxLength={500}
                    rows={5}
                    onChange={(e) => setEditingPersonality(e.target.value)}
                  />
                  <div className="profile-edit-actions">
                    <button
                      className="pill-btn"
                      onClick={() => {
                        void useProfileStore
                          .getState()
                          .savePersonality(editingPersonality)
                          .then(() => setEditingPersonality(null))
                          .catch(toastFail);
                      }}
                    >
                      保存
                    </button>
                    <button className="chip" onClick={() => setEditingPersonality(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <p className="profile-personality">
                  {data.profile.personality || '念念还在慢慢认识你——多聊几次,这里就会有你的样子。'}
                </p>
              )}
            </div>

            <div className="profile-section">
              <div className="profile-label">记得的点点滴滴({data.memories.length})</div>
              {data.memories.length === 0 ? (
                <p className="people-empty">还没有记下什么,去和念念聊聊照片吧</p>
              ) : (
                <div className="memory-list">
                  {[...data.memories].reverse().map((m) =>
                    editingMem?.id === m.id ? (
                      <div key={m.id} className="memory-row memory-row--edit">
                        <input
                          autoFocus
                          value={editingMem.text}
                          maxLength={120}
                          onChange={(e) => setEditingMem({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && editingMem.text.trim())
                              void useProfileStore
                                .getState()
                                .editMemory(m.id, editingMem.text.trim())
                                .then(() => setEditingMem(null))
                                .catch(toastFail);
                          }}
                        />
                        <button className="icon-btn" title="取消" onClick={() => setEditingMem(null)}>
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div key={m.id} className="memory-row">
                        <span className="people-badge">{CATEGORY_LABEL[m.category]}</span>
                        <span className="memory-text">{m.text}</span>
                        <span className="memory-date">{formatDate(m.createdAt)}</span>
                        <div className="people-actions">
                          <button
                            className="icon-btn"
                            title="修改"
                            onClick={() => {
                              setEditingMem({ id: m.id, text: m.text });
                              setConfirmDel(null);
                            }}
                          >
                            ✎
                          </button>
                          <button
                            className={`icon-btn ${confirmDel === m.id ? 'people-del--armed' : ''}`}
                            title="忘掉这条"
                            onClick={() => {
                              if (confirmDel === m.id) {
                                setConfirmDel(null);
                                void useProfileStore.getState().removeMemory(m.id).catch(toastFail);
                              } else setConfirmDel(m.id);
                            }}
                          >
                            {confirmDel === m.id ? '?' : '✕'}
                          </button>
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          </>
        )}
        <button className="icon-btn review-close" title="关闭" onClick={closeOverlay}>
          ✕
        </button>
      </div>
    </div>
  );
}

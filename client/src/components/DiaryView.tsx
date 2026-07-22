import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { MemoryDate } from './MemoryDate';

export function DiaryView() {
  const diary = useAppStore((s) => s.diary);
  const saveDiaryEdits = useAppStore((s) => s.saveDiaryEdits);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const paragraphs = diary.body.split(/\n+/).filter((p) => p.trim());

  const startEdit = () => {
    setDraftTitle(diary.title);
    setDraftBody(diary.body);
    setEditing(true);
  };

  const save = () => {
    setEditing(false);
    void saveDiaryEdits(draftTitle.trim() || '未命名记忆', draftBody.trim());
  };

  return (
    <div className="diary-view">
      <div className="diary-inner">
        {editing ? (
          <>
            <input
              className="diary-title diary-title-input"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
            <MemoryDate className="diary-date" />
            <textarea
              className="diary-body diary-body-input"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={Math.max(8, draftBody.split('\n').length + 2)}
            />
            <div className="diary-edit-actions">
              <button className="pill-btn" onClick={() => setEditing(false)}>
                取消
              </button>
              <button className="pill-btn" onClick={save}>
                保存
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="diary-title">{diary.title}</h1>
            <MemoryDate className="diary-date" />
            <div className="diary-body">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <div className="diary-edit-actions">
              <button className="pill-btn diary-edit-btn" onClick={startEdit}>
                ✎ 修改
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

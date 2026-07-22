import { useRef, useState } from 'react';
import { formatDate } from '../lib/types';
import { fromDateInputValue, toDateInputValue } from '../lib/photoDate';
import { useAppStore } from '../store/useAppStore';

/** Click-to-edit memory date (local day). */
export function MemoryDate({ className = '' }: { className?: string }) {
  const ts = useAppStore((s) => s.entryCreatedAt);
  const setEntryTakenAt = useAppStore((s) => s.setEntryTakenAt);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!ts) return null;

  const commit = (value: string) => {
    setEditing(false);
    const next = fromDateInputValue(value);
    if (next == null) return;
    const prev = toDateInputValue(ts);
    if (value === prev) return;
    void setEntryTakenAt(next);
  };

  if (editing) {
    return (
      <div className={`memory-date memory-date--editing ${className}`.trim()}>
        <input
          ref={inputRef}
          type="date"
          className="memory-date-input"
          defaultValue={toDateInputValue(ts)}
          max={toDateInputValue(Date.now())}
          min="1990-01-01"
          autoFocus
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`memory-date memory-date--btn ${className}`.trim()}
      title="点击修改记忆日期"
      onClick={() => setEditing(true)}
    >
      {formatDate(ts)}
      <span className="memory-date-hint">改</span>
    </button>
  );
}

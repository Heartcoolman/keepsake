import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { refreshEntries, useEntriesStore, thumbUrl } from '../lib/db';
import { AuthImg } from './AuthImg';
import type { Entry, EntryStatus } from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { useGraphStore } from '../store/useGraphStore';
import { usePeopleStore } from '../store/usePeopleStore';
import { useReviewStore } from '../store/useReviewStore';
import { useUserStore } from '../store/useUserStore';

type Filter = 'all' | EntryStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'new', label: '未开始' },
  { key: 'chatting', label: '对话中' },
  { key: 'done', label: '已成念' },
];

export function TimelinePage() {
  const entries = useEntriesStore((s) => s.entries);
  const loaded = useEntriesStore((s) => s.loaded);
  const loadError = useEntriesStore((s) => s.error);
  const addPhotos = useAppStore((s) => s.addPhotos);
  const openEntry = useAppStore((s) => s.openEntry);
  const removeEntry = useAppStore((s) => s.removeEntry);
  const users = useUserStore((s) => s.users);
  const activeUserId = useUserStore((s) => s.activeUserId);
  const activeName = users.find((u) => u.id === activeUserId)?.name;

  const [query, setQuery] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const dq = useDeferredValue(query);
  const [filter, setFilter] = useState<Filter>('all');
  const [sortAsc, setSortAsc] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Lowercased haystack per entry, rebuilt only when entries change — keystroke filtering
  // then does a plain includes() instead of re-concatenating every chat on each render.
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const e of entries) {
      index.set(
        e.id,
        `${e.title} ${e.diaryText} ${e.mood} ${(e.chat ?? []).map((m) => m.content).join(' ')}`.toLowerCase(),
      );
    }
    return index;
  }, [entries]);

  const list = useMemo(() => {
    let l = entries;
    if (filter !== 'all') l = l.filter((e) => e.status === filter);
    const q = dq.trim().toLowerCase();
    if (q) l = l.filter((e) => (searchIndex.get(e.id) ?? '').includes(q));
    return sortAsc ? [...l].reverse() : l;
  }, [entries, filter, dq, sortAsc, searchIndex]);

  const focused: Entry | undefined = list[Math.min(Math.max(focusIdx - 1, 0), list.length - 1)];
  const focusedIsEntry = focusIdx >= 1 && list.length > 0;

  // Index (into scrollRef children, add-card at 0) whose card center is nearest
  // the viewport center — cards are variable-width, so measure each child.
  const computeCenteredIdx = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return 0;
    const center = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    Array.from(el.children).forEach((child, i) => {
      const c = child as HTMLElement;
      const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - center);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }, []);

  // Remember which entry is focused so we can re-find it after the list reorders.
  const focusedIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    focusedIdRef.current = focused?.id;
  });

  // center the first memory card when the carousel appears (index 0 is the add-card)
  const hasEntries = list.length > 0;
  useEffect(() => {
    if (!hasEntries || focusIdx !== 0) return;
    const el = scrollRef.current;
    const child = el?.children[1] as HTMLElement | undefined;
    if (!el || !child) return;
    el.scrollLeft = child.offsetLeft + child.offsetWidth / 2 - el.clientWidth / 2;
    setFocusIdx(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEntries]);

  // When filter/search/sort or add/remove changes `list`, focusIdx is a stale
  // position: re-anchor it. Keep the same entry centered if it survives; otherwise
  // re-derive from the current scroll position so footer text matches the visible card.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || list.length === 0) return;
    const prevId = focusedIdRef.current;
    if (prevId) {
      const newIdx = list.findIndex((e) => e.id === prevId);
      const child = newIdx >= 0 ? (el.children[newIdx + 1] as HTMLElement | undefined) : undefined;
      if (child) {
        el.scrollLeft = child.offsetLeft + child.offsetWidth / 2 - el.clientWidth / 2;
        setFocusIdx(newIdx + 1);
        return;
      }
    }
    setFocusIdx(computeCenteredIdx());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const onScroll = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setFocusIdx(computeCenteredIdx()));
  };

  return (
    <div
      className="timeline"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addPhotos(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        <div className="search-box">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索记忆 · 对话 · 日记"
            aria-label="搜索记忆、对话和日记"
          />
        </div>
        <div className="chips">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip ${filter === f.key ? 'chip--active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="topbar-right">
          <button className="chip" onClick={() => setSortAsc((v) => !v)}>
            ⇅ {sortAsc ? '最早' : '最近'}
          </button>
          <button className="chip" onClick={() => useReviewStore.getState().openOverlay()}>
            ✦ 回顾
          </button>
          <button className="chip" onClick={() => usePeopleStore.getState().openOverlay()}>
            ✧ 人物
          </button>
          <button className="chip" onClick={() => useGraphStore.getState().openOverlay()}>
            ◈ 关系图谱
          </button>
          <button className="chip" onClick={() => useUserStore.getState().openPicker()}>
            ◐ {activeName ?? '选择使用者'}
          </button>
        </div>
      </header>

      {entries.length === 0 ? (
        !loaded ? null : loadError ? (
          <div className="empty-state">
            <p>暂时连不上记忆库。</p>
            <button className="pill-btn" onClick={() => void refreshEntries({ userId: activeUserId ?? undefined })}>
              重试
            </button>
          </div>
        ) : (
        <div className="empty-state">
          <div className="empty-star">✦</div>
          <p>还没有念想。</p>
          <p>把照片拖进来,或点击下方按钮,记下第一张吧。</p>
          <button className="pill-btn" onClick={() => fileRef.current?.click()}>
            ＋ 添加照片
          </button>
        </div>
        )
      ) : (
        <>
          <div className="carousel" ref={scrollRef} onScroll={onScroll} onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) scrollRef.current?.scrollBy({ left: e.deltaY });
          }}>
            <div
              className="tcard add-card"
              role="button"
              tabIndex={0}
              aria-label="添加照片"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => activateOnKeyboard(e, () => fileRef.current?.click())}
            >
              <div className="add-card-inner">
                <span className="add-plus">＋</span>
                <span>添加照片</span>
              </div>
            </div>
            {list.map((e, i) => (
              <CarouselCard
                key={e.id}
                entry={e}
                focused={focusIdx === i + 1}
                onClick={(rect) => void openEntry(e.id, rect)}
              />
            ))}
          </div>
          {focusedIsEntry && focused && (
            <div className="carousel-footer">
              <div className="card-title">{focused.title}</div>
              <div className="card-page">
                {Math.min(focusIdx, list.length)} / {list.length}
              </div>
              <div className="footer-actions">
                <button
                  className="pill-btn open-day"
                  aria-label={`翻开${focused.title}`}
                  onClick={() =>
                    void openEntry(
                      focused.id,
                      document.querySelector('.tcard--focus')?.getBoundingClientRect() ?? null,
                    )
                  }
                >
                  ✧ 翻开这一天
                </button>
                <button
                  className={`pill-btn del-btn ${confirmDel === focused.id ? 'del-btn--armed' : ''}`}
                  aria-label={confirmDel === focused.id ? `确认丢弃${focused.title}` : `丢弃${focused.title}`}
                  onClick={() => {
                    if (confirmDel === focused.id) {
                      setConfirmDel(null);
                      void removeEntry(focused.id);
                    } else setConfirmDel(focused.id);
                  }}
                >
                  {confirmDel === focused.id ? '确认丢弃?' : '✕ 丢弃'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addPhotos(e.target.files);
          e.target.value = '';
        }}
      />

      {dragging && (
        <div className="drop-overlay">
          <div>松手,把这一天丢进来 ✦</div>
        </div>
      )}
    </div>
  );
}

function CarouselCard({
  entry,
  focused,
  onClick,
}: {
  entry: Entry;
  focused: boolean;
  onClick: (rect: DOMRect) => void;
}) {
  return (
    <div
      className={`tcard ${focused ? 'tcard--focus' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`打开${entry.title}`}
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClick(e.currentTarget.getBoundingClientRect());
      }}
    >
      <AuthImg path={thumbUrl(entry.id)} alt={entry.title} draggable={false} lazy />
    </div>
  );
}

function activateOnKeyboard(event: KeyboardEvent<HTMLElement>, action: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

import { useEffect, useState } from 'react';
import { useDialog } from '../lib/useDialog';
import { faceThumbUrl, fetchUnassignedFaces } from '../lib/api';
import type { FaceRef, PersonDTO } from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { usePeopleStore } from '../store/usePeopleStore';
import { AuthImg } from './AuthImg';
import { FaceNamer } from './FaceNamer';

type Tab = 'people' | 'faces';

export function PeopleOverlay() {
  const open = usePeopleStore((s) => s.open);
  const people = usePeopleStore((s) => s.people);
  const closeOverlay = usePeopleStore((s) => s.closeOverlay);

  const [tab, setTab] = useState<Tab>('people');
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const panelRef = useDialog(open, closeOverlay);

  if (!open) return null;
  const merging = mergeFrom ? people.find((p) => p.id === mergeFrom) : null;

  const doMerge = async (targetId: string) => {
    if (!mergeFrom || targetId === mergeFrom) return;
    try {
      await usePeopleStore.getState().merge(targetId, mergeFrom);
      useAppStore.getState().showToast('已合并 ✦');
    } catch {
      useAppStore.getState().showToast('没合并成,稍后再试');
    }
    setMergeFrom(null);
  };

  return (
    <div className="review-overlay" onClick={closeOverlay} role="presentation">
      <div
        className="user-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="念念认识的人"
      >
        <div className="user-heading">✧ 念念认识的人</div>
        <div className="tab-bar people-tabs">
          <button className={`tab ${tab === 'people' ? 'tab--active' : ''}`} onClick={() => setTab('people')}>
            人物
          </button>
          <button className={`tab ${tab === 'faces' ? 'tab--active' : ''}`} onClick={() => setTab('faces')}>
            未命名的脸
          </button>
        </div>

        {tab === 'people' ? (
          <>
            {merging && (
              <p className="user-hint people-merge-hint">
                选择要把「{merging.name}」并入的人物,或
                <button className="chip" onClick={() => setMergeFrom(null)}>取消</button>
              </p>
            )}
            {people.length === 0 && !creating && <p className="people-empty">还没有人物档案</p>}
            <div className="people-list">
              {people.map((p) =>
                editId === p.id ? (
                  <PersonForm key={p.id} person={p} onDone={() => setEditId(null)} />
                ) : (
                  <div
                    key={p.id}
                    className={`people-row ${merging && p.id !== mergeFrom ? 'people-row--target' : ''}`}
                    onClick={merging && p.id !== mergeFrom ? () => void doMerge(p.id) : undefined}
                  >
                    <span className="user-avatar">
                      {p.enrolledFrom.length ? (
                        <AuthImg
                          path={faceThumbUrl(p.enrolledFrom[0]!.entryId, p.enrolledFrom[0]!.faceIndex)}
                          alt={p.name}
                          fallback={p.name.slice(0, 1)}
                        />
                      ) : (
                        p.name.slice(0, 1)
                      )}
                    </span>
                    <div>
                      <div className="people-name">{p.name}</div>
                      {p.relation && <div className="people-relation">{p.relation}</div>}
                    </div>
                    {p.isUser && <span className="people-badge">使用者</span>}
                    <div className="people-faces">
                      {p.enrolledFrom.slice(1, 5).map((f, i) => (
                        <AuthImg key={i} path={faceThumbUrl(f.entryId, f.faceIndex)} alt="" />
                      ))}
                    </div>
                    {!merging && (
                      <div className="people-actions">
                        <button className="icon-btn" title="编辑" onClick={() => { setEditId(p.id); setConfirmDel(null); }}>
                          ✎
                        </button>
                        {people.length > 1 && (
                          <button className="icon-btn" title="并入其他人物" onClick={() => setMergeFrom(p.id)}>
                            ⇄
                          </button>
                        )}
                        <button
                          className={`icon-btn ${confirmDel === p.id ? 'people-del--armed' : ''}`}
                          title="删除"
                          onClick={() => {
                            if (confirmDel === p.id) {
                              setConfirmDel(null);
                              void usePeopleStore.getState().remove(p.id).catch(() =>
                                useAppStore.getState().showToast('没删掉,稍后再试'),
                              );
                            } else setConfirmDel(p.id);
                          }}
                        >
                          {confirmDel === p.id ? '?' : '✕'}
                        </button>
                      </div>
                    )}
                  </div>
                ),
              )}
              {creating ? (
                <PersonForm onDone={() => setCreating(false)} />
              ) : (
                <button className="pill-btn people-add" onClick={() => setCreating(true)}>
                  ＋ 添加人物
                </button>
              )}
            </div>
          </>
        ) : (
          <UnassignedFaces />
        )}

        <button className="icon-btn review-close" title="关闭" onClick={closeOverlay}>
          ✕
        </button>
      </div>
    </div>
  );
}

function UnassignedFaces() {
  const [clusters, setClusters] = useState<{ faces: FaceRef[] }[] | null>(null);
  const [naming, setNaming] = useState<number | null>(null);

  const load = () => {
    setNaming(null);
    setClusters(null);
    fetchUnassignedFaces()
      .then(setClusters)
      .catch(() => setClusters([]));
  };
  useEffect(load, []);

  if (clusters === null) return <p className="people-empty">正在整理面孔…</p>;
  if (!clusters.length) return <p className="people-empty">照片里的脸都认全啦</p>;

  return (
    <div className="people-list">
      {clusters.map((c, i) => (
        <div key={i} className="people-row people-cluster">
          <div className="people-faces people-faces--big">
            {c.faces.slice(0, 5).map((f, j) => (
              <AuthImg key={j} path={faceThumbUrl(f.entryId, f.faceIndex)} alt="" />
            ))}
            {c.faces.length > 5 && <span className="people-more">+{c.faces.length - 5}</span>}
          </div>
          {naming === i ? (
            <FaceNamer samples={c.faces.slice(0, 10)} onDone={load} />
          ) : (
            <button className="pill-btn" onClick={() => setNaming(i)}>
              这是谁?
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function PersonForm({ person, onDone }: { person?: PersonDTO; onDone: () => void }) {
  const [name, setName] = useState(person?.name ?? '');
  const [relation, setRelation] = useState(person?.relation ?? '');
  const [isUser, setIsUser] = useState(person?.isUser ?? false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const store = usePeopleStore.getState();
      if (person) await store.update(person.id, { name: name.trim(), relation: relation.trim(), isUser });
      else await store.create(name.trim(), relation.trim(), isUser);
      onDone();
    } catch {
      useAppStore.getState().showToast('没存上,稍后再试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="people-row people-row--edit">
      <input
        autoFocus
        value={name}
        maxLength={12}
        placeholder="名字"
        onChange={(e) => setName(e.target.value)}
      />
      <input
        value={relation}
        maxLength={12}
        placeholder="你与TA的关系(可留空)"
        onChange={(e) => setRelation(e.target.value)}
      />
      <button
        className={`chip ${isUser ? 'chip--active' : ''}`}
        title="会用这个应用的家人"
        onClick={() => setIsUser((v) => !v)}
      >
        使用者
      </button>
      <div className="people-actions">
        <button className="icon-btn" title="保存" disabled={!name.trim() || saving} onClick={() => void submit()}>
          ✓
        </button>
        <button className="icon-btn" title="取消" onClick={onDone}>
          ✕
        </button>
      </div>
    </div>
  );
}

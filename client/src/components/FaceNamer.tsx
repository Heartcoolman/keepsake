import { useState } from 'react';
import type { FaceRef } from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { usePeopleStore } from '../store/usePeopleStore';

/** shared "这是谁?" body: attach faces to an existing person, or create a new one */
export function FaceNamer({ samples, onDone }: { samples: FaceRef[]; onDone: () => void }) {
  const people = usePeopleStore((s) => s.people);
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('');
  const [saving, setSaving] = useState(false);

  const finish = (who: string) => {
    useAppStore.getState().showToast(`记住了,这是${who} ✦`);
    void useAppStore.getState().refreshEntryPeople();
    onDone();
  };

  const attach = async (personId: string, who: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await usePeopleStore.getState().update(personId, { addSamples: samples });
      finish(who);
    } catch {
      useAppStore.getState().showToast('没记住,稍后再试');
    } finally {
      setSaving(false);
    }
  };

  const createNew = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await usePeopleStore.getState().create(name.trim(), relation.trim(), false, samples);
      finish(name.trim());
    } catch {
      useAppStore.getState().showToast('没记住,稍后再试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="face-namer">
      {people.length > 0 && (
        <div className="face-namer-existing">
          {people.map((p) => (
            <button
              key={p.id}
              className="chip"
              disabled={saving}
              onClick={() => void attach(p.id, p.name)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="face-namer-new">
        <input
          value={name}
          maxLength={12}
          placeholder="新名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void createNew()}
        />
        <input
          value={relation}
          maxLength={12}
          placeholder="关系(可留空)"
          onChange={(e) => setRelation(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void createNew()}
        />
        <button className="pill-btn" disabled={!name.trim() || saving} onClick={() => void createNew()}>
          {saving ? '…' : '记住'}
        </button>
      </div>
    </div>
  );
}

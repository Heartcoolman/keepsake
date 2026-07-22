import { useState } from 'react';
import { faceThumbUrl } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { AuthImg } from './AuthImg';
import { FaceNamer } from './FaceNamer';

/** floating crops of faces 念念 didn't recognize — tap one to tell her who it is */
export function FaceChips() {
  const entryId = useAppStore((s) => s.entryId);
  const people = useAppStore((s) => s.people);
  const unknownFaces = useAppStore((s) => s.unknownFaces);
  const [naming, setNaming] = useState<number | null>(null);

  if (!entryId || unknownFaces <= 0) return null;
  const matched = new Set(people.map((p) => p.faceIndex));
  const total = people.length + unknownFaces;
  const unknownIdx = Array.from({ length: total }, (_, i) => i).filter((i) => !matched.has(i));

  return (
    <div className="face-chips">
      <span className="face-chips-hint">这是谁?</span>
      {unknownIdx.map((idx) => (
        <div key={idx} className="face-chip-wrap">
          <button
            className={`face-chip ${naming === idx ? 'face-chip--active' : ''}`}
            onClick={() => setNaming(naming === idx ? null : idx)}
          >
            <AuthImg path={faceThumbUrl(entryId, idx)} alt="未认出的脸" draggable={false} />
          </button>
          {naming === idx && (
            <div className="face-pop">
              <FaceNamer
                samples={[{ entryId, faceIndex: idx }]}
                onDone={() => setNaming(null)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

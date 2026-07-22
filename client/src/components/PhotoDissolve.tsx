import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore, ENTRY_ZOOM_MS } from '../store/useAppStore';

/** The reference video's signature entrance, in two beats:
 *  1. the clicked card FLIP-zooms from its carousel rect to fullscreen;
 *  2. the moment the engine sand-bursts (`sandified`), the sharp photo fades out
 *     underneath the particles while its height tracks the camera dolly. */
export function PhotoDissolve() {
  const url = useAppStore((s) => s.entryBlobUrl);
  const rect = useAppStore((s) => s.entryRect);
  const sandified = useAppStore((s) => s.sandified);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => setGone(false), [url]);

  // card → fullscreen zoom; the final layout is the flex-centered 83vh img,
  // so we animate the wrapper from the card's rect back to identity.
  // layout effect: the start transform must be applied before first paint
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || !rect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const finalH = Math.min(0.83 * vh, (0.88 * vw * rect.h) / rect.w);
    const s0 = rect.h / finalH;
    const tx = rect.x + rect.w / 2 - vw / 2;
    const ty = rect.y + rect.h / 2 - vh / 2;
    el.animate(
      [
        { transform: `translate(${tx}px, ${ty}px) scale(${s0})` },
        { transform: 'translate(0px, 0px) scale(1)' },
      ],
      { duration: ENTRY_ZOOM_MS, easing: 'cubic-bezier(0.32, 0, 0.24, 1)', fill: 'both' },
    );
  }, [url, rect]);

  useEffect(() => {
    if (!sandified) return;
    const t = setTimeout(() => setGone(true), 1100);
    return () => clearTimeout(t);
  }, [sandified]);

  if (!url || gone) return null;
  const cls = `photo-dissolve${rect ? ' photo-dissolve--flip' : ''}${
    sandified ? ' photo-dissolve--shrink photo-dissolve--out' : ''
  }`;
  return (
    <div className={cls} ref={wrapRef}>
      <img src={url} alt="" draggable={false} />
    </div>
  );
}

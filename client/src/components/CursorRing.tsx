import { useEffect, useRef } from 'react';

const coarse =
  typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const reducedMotion =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Touch devices have no pointer to replace; reduced-motion users keep the native cursor.
const disabled = coarse || reducedMotion;

export function CursorRing() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) return;
    document.body.classList.add('no-cursor');
    let x = innerWidth / 2;
    let y = innerHeight / 2;
    let tx = x;
    let ty = y;
    let raf = 0;
    const move = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      x += (tx - x) * 0.35;
      y += (ty - y) * 0.35;
      if (ref.current) ref.current.style.transform = `translate3d(${x - 10}px, ${y - 10}px, 0)`;
    };
    window.addEventListener('pointermove', move);
    loop();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      document.body.classList.remove('no-cursor');
    };
  }, []);

  if (disabled) return null;
  return <div ref={ref} className="cursor-ring" aria-hidden="true" />;
}

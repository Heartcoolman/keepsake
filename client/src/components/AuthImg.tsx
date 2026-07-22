import { useEffect, useRef, useState, type ReactNode } from 'react';
import { acquireMediaUrl, releaseMediaUrl } from '../lib/media';

/** <img> that loads a Bearer-protected API path as a blob URL.
 *  Pass `lazy` to defer the fetch until the element nears the viewport (timeline cards).
 *  Pass `fallback` to render something (e.g. a name initial) when the fetch fails. */
export function AuthImg({
  path,
  alt,
  className,
  draggable = false,
  lazy = false,
  fallback,
}: {
  path: string;
  alt: string;
  className?: string;
  draggable?: boolean;
  lazy?: boolean;
  fallback?: ReactNode;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const holderRef = useRef<HTMLDivElement>(null);

  // Lazy mode: only fetch once the placeholder scrolls near the viewport.
  useEffect(() => {
    if (visible) return;
    const el = holderRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let released = false;
    let acquired: string | null = null;
    // The underlying fetch is shared/deduped in lib/media and deliberately not abortable
    // by a single consumer — an unmount just drops this component's reference.
    acquireMediaUrl(path)
      .then((url) => {
        acquired = path;
        if (released) {
          releaseMediaUrl(path);
          return;
        }
        setSrc(url);
      })
      .catch(() => {
        if (!released) {
          setSrc(null);
          setFailed(true);
        }
      });
    return () => {
      released = true;
      if (acquired) releaseMediaUrl(acquired);
      setSrc(null);
      setFailed(false);
    };
  }, [path, visible]);

  if (!src) {
    if (failed && fallback !== undefined) return <>{fallback}</>;
    return <div ref={holderRef} className={className} role="img" aria-label={alt} />;
  }
  return <img src={src} alt={alt} className={className} draggable={draggable} />;
}

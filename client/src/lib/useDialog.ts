import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal accessibility helper: when `open`, moves focus into the dialog, restores focus to the
 * previously-focused element on close, traps Tab within the dialog, and closes on Escape.
 * Attach the returned ref to the dialog container and give it `tabIndex={-1}`.
 */
export function useDialog(
  open: boolean,
  onClose: () => void,
  opts: { closeOnEsc?: boolean } = {},
) {
  const ref = useRef<HTMLDivElement>(null);
  const closeOnEsc = opts.closeOnEsc ?? true;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    (focusables()[0] ?? node)?.focus?.();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (closeOnEsc) {
          e.stopPropagation();
          onClose();
        }
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, closeOnEsc]);

  return ref;
}

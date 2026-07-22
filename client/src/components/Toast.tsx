import { useAppStore } from '../store/useAppStore';

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  const kind = useAppStore((s) => s.toastKind);
  if (!toast) return null;
  return <div className={kind === 'error' ? 'toast error' : 'toast'}>{toast}</div>;
}

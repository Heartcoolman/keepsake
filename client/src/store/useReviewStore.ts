import { create } from 'zustand';
import { getMonthlyReview, streamMonthlyReview } from '../lib/api';
import { useEntriesStore } from '../lib/db';
import { toYearMonth } from '../lib/types';
import { useAppStore } from './useAppStore';
import { activeUserId } from './useUserStore';

interface ReviewState {
  open: boolean;
  month: string;
  userId: string;
  text: string;
  generatedAt: number;
  generating: boolean;
  loaded: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
  setMonth: (ym: string) => void;
  syncUser: (userId: string) => void;
  generate: () => Promise<void>;
}

/** Most recent yearMonth among this user's entries, falling back to the current month. */
function latestMonthFor(uid: string): string {
  const months = [...new Set(
    useEntriesStore.getState().entries
      .filter((e) => !uid || e.userId === uid)
      .map((e) => e.yearMonth),
  )].sort();
  return months[months.length - 1] ?? toYearMonth(Date.now());
}

export const useReviewStore = create<ReviewState>((set, get) => {
  let requestSeq = 0;
  let activeController: AbortController | null = null;

  async function loadMonth(ym: string, uid = activeUserId()): Promise<void> {
    const seq = ++requestSeq;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    set({ month: ym, userId: uid, text: '', generatedAt: 0, loaded: false, generating: false });
    const review = uid ? await getMonthlyReview(ym, uid, controller.signal).catch(() => undefined) : undefined;
    if (get().month !== ym || get().userId !== uid || seq !== requestSeq) return;
    set({ text: review?.text ?? '', generatedAt: review?.generatedAt ?? 0, loaded: true });
  }

  return {
    open: false,
    month: toYearMonth(Date.now()),
    userId: '',
    text: '',
    generatedAt: 0,
    generating: false,
    loaded: false,

    openOverlay() {
      const uid = activeUserId();
      if (!uid) {
        useAppStore.getState().showToast('请先登录');
        return;
      }
      set({ open: true });
      void loadMonth(latestMonthFor(uid), uid);
    },

    closeOverlay() {
      requestSeq++;
      activeController?.abort();
      activeController = null;
      set({ open: false });
    },

    setMonth(ym) {
      void loadMonth(ym);
    },

    syncUser(uid) {
      if (get().userId === uid) return;
      void loadMonth(latestMonthFor(uid), uid);
    },

    async generate() {
      const ym = get().month;
      if (get().generating) return;
      const uid = activeUserId();
      if (!uid) return;
      const seq = ++requestSeq;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      set({ generating: true, text: '', userId: uid });
      try {
        const full = await streamMonthlyReview(ym, uid, (t) => {
          if (get().month === ym && get().userId === uid && seq === requestSeq) set({ text: t });
        }, controller.signal);
        if (!full.trim()) throw new Error('empty monthly review');
        if (get().month === ym && get().userId === uid && seq === requestSeq)
          set({ text: full.trim(), generatedAt: Date.now(), generating: false });
      } catch {
        if (get().month !== ym || get().userId !== uid || seq !== requestSeq) return;
        useAppStore.getState().showToast('回顾没写成,休息一下再试');
        void loadMonth(ym, uid); // restore whatever the server still has
      } finally {
        if (activeController === controller) activeController = null;
      }
    },
  };
});

import { create } from 'zustand';
import {
  deleteMemoryItem,
  editMemoryItem,
  fetchProfile,
  savePersonality,
  type UserProfileData,
} from '../lib/api';
import { useUserStore } from './useUserStore';

interface ProfileState {
  open: boolean;
  userId: string | null;
  data: UserProfileData | null;
  requestSeq: number;
  openOverlay: () => void;
  closeOverlay: () => void;
  savePersonality: (text: string) => Promise<void>;
  editMemory: (memId: string, text: string) => Promise<void>;
  removeMemory: (memId: string) => Promise<void>;
}

// Profile writes are user-visible edits. Keep them in invocation order so a
// slower response cannot leave the server with an older value, and use a
// sequence number to ignore responses that no longer describe the latest edit.
let mutationTail: Promise<void> = Promise.resolve();
let mutationSeq = 0;

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  open: false,
  userId: null,
  data: null,

  // Every profile request is tied to the user that opened the panel. A late
  // response from a previous user must never replace the current profile.
  requestSeq: 0,

  openOverlay() {
    const userId = useUserStore.getState().activeUserId;
    if (!userId) return;
    const requestSeq = get().requestSeq + 1;
    const observedMutationSeq = mutationSeq;
    set({ open: true, userId, data: null, requestSeq });
    // Wait for writes that were already in flight before taking the snapshot;
    // otherwise a late profile read could reintroduce the pre-edit value.
    mutationTail
      .then(
        () => fetchProfile(userId),
        () => fetchProfile(userId),
      )
      .then((data) => {
        if (
          get().open &&
          get().userId === userId &&
          get().requestSeq === requestSeq &&
          mutationSeq === observedMutationSeq
        )
          set({ data });
      })
      .catch(() => {
        if (
          get().open &&
          get().userId === userId &&
          get().requestSeq === requestSeq &&
          mutationSeq === observedMutationSeq
        ) {
          set({ data: { profile: { personality: '', personalityUpdatedAt: 0, sessionCount: 0, mood: '', moodUpdatedAt: 0 }, memories: [] } });
        }
      });
  },

  closeOverlay() {
    mutationSeq++;
    set((s) => ({ open: false, userId: null, data: null, requestSeq: s.requestSeq + 1 }));
  },

  async savePersonality(text) {
    const { userId } = get();
    if (!userId) return;
    const requestSeq = get().requestSeq;
    const sequence = ++mutationSeq;
    const data = await enqueueMutation(() => savePersonality(userId, text));
    if (get().open && get().userId === userId && get().requestSeq === requestSeq && mutationSeq === sequence)
      set({ data });
  },

  async editMemory(memId, text) {
    const { userId } = get();
    if (!userId) return;
    const requestSeq = get().requestSeq;
    const sequence = ++mutationSeq;
    const data = await enqueueMutation(() => editMemoryItem(userId, memId, text));
    if (get().open && get().userId === userId && get().requestSeq === requestSeq && mutationSeq === sequence)
      set({ data });
  },

  async removeMemory(memId) {
    const { userId } = get();
    if (!userId) return;
    const requestSeq = get().requestSeq;
    const sequence = ++mutationSeq;
    const data = await enqueueMutation(() => deleteMemoryItem(userId, memId));
    if (get().open && get().userId === userId && get().requestSeq === requestSeq && mutationSeq === sequence)
      set({ data });
  },
}));

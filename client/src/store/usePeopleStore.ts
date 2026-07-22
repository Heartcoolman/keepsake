import { create } from 'zustand';
import { createPerson, deletePerson, fetchPeople, mergePerson, updatePerson } from '../lib/api';
import type { FaceRef, PersonDTO } from '../lib/types';
import { useUserStore } from './useUserStore';

interface PeopleState {
  open: boolean;
  people: PersonDTO[];
  refresh: () => Promise<void>;
  openOverlay: () => void;
  closeOverlay: () => void;
  create: (name: string, relation: string, isUser: boolean, samples?: FaceRef[]) => Promise<void>;
  update: (
    id: string,
    patch: { name?: string; relation?: string; isUser?: boolean; addSamples?: FaceRef[] },
  ) => Promise<void>;
  merge: (id: string, fromId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

let refreshSeq = 0;

export const usePeopleStore = create<PeopleState>((set, get) => ({
  open: false,
  people: [],

  async refresh() {
    const seq = ++refreshSeq;
    const next = await fetchPeople().catch(() => undefined);
    if (seq !== refreshSeq) return;
    if (next) set({ people: next });
    void useUserStore.getState().refresh();
  },

  openOverlay() {
    set({ open: true });
    void get().refresh();
  },

  closeOverlay() {
    set({ open: false });
  },

  async create(name, relation, isUser, samples) {
    await createPerson({ name, relation, isUser, samples });
    await get().refresh();
  },

  async update(id, patch) {
    await updatePerson(id, patch);
    await get().refresh();
  },

  async merge(id, fromId) {
    await mergePerson(id, fromId);
    await get().refresh();
  },

  async remove(id) {
    await deletePerson(id);
    await get().refresh();
  },
}));

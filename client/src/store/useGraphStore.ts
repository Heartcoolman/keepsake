import { create } from 'zustand';
import { deleteRelationship, fetchGraph } from '../lib/api';
import type { GraphNode, RelationshipDTO } from '../lib/types';

interface GraphState {
  open: boolean;
  nodes: GraphNode[];
  edges: RelationshipDTO[];
  loading: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
  refresh: () => Promise<void>;
  removeEdge: (id: string) => Promise<void>;
}

let refreshSeq = 0;

export const useGraphStore = create<GraphState>((set, get) => ({
  open: false,
  nodes: [],
  edges: [],
  loading: false,

  openOverlay() {
    set({ open: true });
    void get().refresh();
  },

  closeOverlay() {
    set({ open: false });
  },

  async refresh() {
    const seq = ++refreshSeq;
    set({ loading: true });
    const next = await fetchGraph().catch(() => undefined);
    if (seq !== refreshSeq) return;
    if (next) set({ nodes: next.nodes, edges: next.edges, loading: false });
    else set({ loading: false });
  },

  async removeEdge(id) {
    await deleteRelationship(id);
    set({ edges: get().edges.filter((e) => e.id !== id) });
  },
}));

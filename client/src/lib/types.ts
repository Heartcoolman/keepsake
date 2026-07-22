export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type EntryStatus = 'new' | 'chatting' | 'done';

/** How the memory date was determined */
export type DateSource = 'exif' | 'filename' | 'file' | 'now' | 'manual' | 'chat';

export interface PersonRef {
  personId: string;
  faceIndex: number;
}

export interface FaceRef {
  entryId: string;
  faceIndex: number;
}

export interface Entry {
  id: string;
  /** Memory/event time — timeline sort & diary date. Alias of takenAt. */
  createdAt: number;
  /** Memory/event time (canonical). Falls back to createdAt for legacy rows. */
  takenAt: number;
  /** When the photo was uploaded into the app. */
  uploadedAt: number;
  dateSource: DateSource;
  yearMonth: string; // "2026-07"
  status: EntryStatus;
  title: string;
  mood: string;
  diaryText: string;
  imageDescription: string;
  chat: ChatMessage[];
  /** Owner account id (v1). */
  ownerId?: string;
  userId: string;
  people: PersonRef[];
  unknownFaces: number;
  faceScannedAt: number;
  relationScannedAt: number;
}

export interface PersonDTO {
  id: string;
  name: string;
  relation: string;
  isUser: boolean;
  createdAt: number;
  updatedAt: number;
  templateCount: number;
  enrolledFrom: FaceRef[];
}

export interface RelationEvidence {
  entryId: string;
  kind: 'cooccur' | 'ai';
  createdAt: number;
}

export interface RelationshipDTO {
  id: string;
  a: string;
  b: string;
  label: string;
  confidence: number;
  evidence: RelationEvidence[];
  createdAt: number;
  updatedAt: number;
  /** synthesized from Person.relation at query time — not deletable */
  virtual?: boolean;
}

export interface GraphNode extends PersonDTO {
  degree: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: RelationshipDTO[];
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function toYearMonth(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function entryTakenAt(e: Pick<Entry, 'takenAt' | 'createdAt'>): number {
  return e.takenAt || e.createdAt;
}

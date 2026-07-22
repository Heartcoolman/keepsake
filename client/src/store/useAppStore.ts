import { create } from 'zustand';
import { addEntry, deleteEntry, getEntry, getEntryImage, refreshEntries, updateEntry } from '../lib/db';
import {
  sessionOpen,
  sessionMessage,
  sessionComplete,
  parseDiaryStream,
} from '../lib/api';
import { estimateDepth } from '../lib/depth';
import { downscaleImage, makeThumb } from '../lib/image';
import { parseChatDate, shouldApplyChatDate } from '../lib/parseChatDate';
import { resolvePhotoDate } from '../lib/photoDate';
import {
  toYearMonth,
  formatDate,
  entryTakenAt,
  type ChatMessage,
  type Entry,
  type PersonRef,
} from '../lib/types';
import { getEngine } from '../particles/engineRef';
import { activeUserId } from './useUserStore';

type View = 'timeline' | 'session';
type Phase = 'idle' | 'loading' | 'analyzing' | 'chatting' | 'condensing' | 'revealing' | 'done';
type SessionTab = 'diary' | 'chat';

interface Diary {
  title: string;
  mood: string;
  body: string;
}

interface AppState {
  view: View;
  entryId: string | null;
  entryCreatedAt: number;
  /** blob URL of the opened photo — drives the photo→particles dissolve on entry */
  entryBlobUrl: string | null;
  /** screen rect of the clicked card — the photo FLIP-zooms from here to fullscreen */
  entryRect: { x: number; y: number; w: number; h: number } | null;
  /** flips true the instant the particle sand-burst starts — the DOM photo fades out on it */
  sandified: boolean;
  phase: Phase;
  sessionTab: SessionTab;
  messages: ChatMessage[];
  imageDescription: string;
  mood: string;
  people: PersonRef[];
  unknownFaces: number;
  diary: Diary;
  interimText: string | null;
  textHidden: boolean;
  inputMode: 'voice' | 'keyboard';
  busy: boolean;
  toast: string | null;
  toastKind: 'info' | 'error';

  addPhotos: (files: FileList | File[]) => Promise<void>;
  openEntry: (id: string, fromRect?: DOMRect | null) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  sendUserMessage: (text: string) => Promise<void>;
  /** re-pull people/unknownFaces after a face was named (server rescans on enrollment) */
  refreshEntryPeople: () => Promise<void>;
  saveDiaryEdits: (title: string, body: string) => Promise<void>;
  /** Update memory date (timeline / diary). Does not rewrite diary body. */
  setEntryTakenAt: (ts: number) => Promise<void>;
  generateDiary: () => Promise<void>;
  backToTimeline: () => void;
  setSessionTab: (tab: SessionTab) => void;
  setInterim: (text: string | null) => void;
  setInputMode: (mode: 'voice' | 'keyboard') => void;
  toggleTextHidden: () => void;
  showToast: (msg: string, kind?: 'info' | 'error') => void;
}

const EMPTY_DIARY: Diary = { title: '', mood: '', body: '' };
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = window.setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
/** card→fullscreen zoom duration; the sand-burst waits for it (PhotoDissolve animates the same span) */
export const ENTRY_ZOOM_MS = 460;

function moodToAmbience(mood: string): 'rain' | 'snow' | 'dust' {
  if (/[雨思念忧伤愁怀]/.test(mood)) return 'rain';
  if (/[静雪冬凉安]/.test(mood)) return 'snow';
  return 'dust';
}

export const useAppStore = create<AppState>((set, get) => {
  interface Operation {
    generation: number;
    controller: AbortController;
    userId: string;
    targetId?: string;
    release: () => void;
  }

  let sessionGeneration = 0;
  const activeOperations = new Set<AbortController>();
  let imageLoadTail: Promise<void> = Promise.resolve();
  let toastToken = 0;

  const invalidateSession = (): void => {
    sessionGeneration++;
    for (const controller of activeOperations) controller.abort();
    activeOperations.clear();
  };

  const beginOperation = (newSession = false, userId = activeUserId(), targetId?: string): Operation => {
    if (newSession) invalidateSession();
    const controller = new AbortController();
    activeOperations.add(controller);
    let released = false;
    return {
      generation: sessionGeneration,
      controller,
      userId,
      targetId,
      release: () => {
        if (released) return;
        released = true;
        activeOperations.delete(controller);
      },
    };
  };

  const current = (id: string, operation: Operation): boolean =>
    (get().entryId === id || operation.targetId === id) &&
    sessionGeneration === operation.generation &&
    (!operation.userId || activeUserId() === operation.userId) &&
    !operation.controller.signal.aborted;

  /** Queue image decoding so an aborted load cannot finish after a newer image. */
  const setImageSerial = async (id: string, operation: Operation, blob: Blob): Promise<void> => {
    const task = imageLoadTail.then(async () => {
      if (!current(id, operation)) return;
      const engine = getEngine();
      if (!engine) return;
      await engine.setImage(blob, { atTarget: true });
    });
    imageLoadTail = task.catch(() => undefined);
    await task;
  };

  const setLastAssistant = (id: string, operation: Operation, content: string) => {
    if (!current(id, operation)) return;
    set((s) => {
      if (s.entryId !== id || sessionGeneration !== operation.generation) return s;
      const messages = s.messages.slice();
      if (!messages.length) return s;
      messages[messages.length - 1] = { role: 'assistant', content };
      return { messages };
    });
  };

  async function typewrite(id: string, operation: Operation, text: string): Promise<void> {
    if (!current(id, operation)) return;
    set((s) => ({ messages: [...s.messages, { role: 'assistant', content: '' }] }));
    for (let i = 2; i < text.length + 2; i += 2) {
      if (!current(id, operation)) return;
      setLastAssistant(id, operation, text.slice(0, i));
      await sleep(42, operation.controller.signal);
    }
  }

  async function runDepth(id: string, blob: Blob, operation: Operation): Promise<void> {
    try {
      const { depth, layers } = await estimateDepth(blob, id, operation.controller.signal);
      if (!current(id, operation)) return;
      const engine = getEngine();
      if (!engine) return;
      try {
        if (layers) engine.applyLayers(layers);
        else if (depth) engine.applyDepthMap(depth);
        else engine.fallbackDepth();
      } catch (error) {
        console.warn('[depth] particle application failed', error);
        if (!current(id, operation)) return;
        try {
          engine.fallbackDepth();
        } catch (fallbackError) {
          console.warn('[depth] fallback application failed', fallbackError);
        }
      }
    } catch (error) {
      if (!current(id, operation)) return;
      console.warn('[depth] run failed', error);
      try {
        getEngine()?.fallbackDepth();
      } catch (fallbackError) {
        console.warn('[depth] fallback application failed', fallbackError);
      }
    }
  }

  return {
    view: 'timeline',
    entryId: null,
    entryCreatedAt: 0,
    entryBlobUrl: null,
    entryRect: null,
    sandified: false,
    phase: 'idle',
    sessionTab: 'chat',
    messages: [],
    imageDescription: '',
    mood: '',
    people: [],
    unknownFaces: 0,
    diary: EMPTY_DIARY,
    interimText: null,
    textHidden: false,
    inputMode: 'voice',
    busy: false,
    toast: null,
    toastKind: 'info',

    async addPhotos(files) {
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (!list.length) {
        get().showToast('只支持图片文件(jpg / png)');
        return;
      }
      const uid = activeUserId();
      if (!uid) {
        get().showToast('请先登录');
        return;
      }
      const ids: string[] = [];
      let missingDate = 0;
      for (const file of list) {
        try {
          // read EXIF before canvas downscale strips metadata
          const { takenAt, source } = await resolvePhotoDate(file);
          if (source === 'now') missingDate++;
          const working = await downscaleImage(file);
          const thumb = await makeThumb(working);
          const uploadedAt = Date.now();
          const entry: Entry = {
            // crypto.randomUUID is secure-context-only; keep working on plain-http LAN deploys
            id:
              globalThis.crypto?.randomUUID?.() ??
              `${uploadedAt.toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
            createdAt: takenAt,
            takenAt,
            uploadedAt,
            dateSource: source,
            yearMonth: toYearMonth(takenAt),
            status: 'new',
            title: '未命名记忆',
            mood: '',
            diaryText: '',
            imageDescription: '',
            chat: [],
            userId: uid,
            people: [],
            unknownFaces: 0,
            faceScannedAt: 0,
            relationScannedAt: 0,
          };
          await addEntry(entry, working, thumb, { refresh: false });
          ids.push(entry.id);
        } catch {
          get().showToast(`「${file.name}」没存上,检查格式或网络`);
        }
      }
      // Single refresh for the whole batch instead of one per photo.
      if (ids.length) await refreshEntries({ userId: uid });
      if (ids.length >= 3 && missingDate >= Math.ceil(ids.length * 0.5)) {
        get().showToast(
          `有 ${missingDate} 张没读到拍摄时间,已按今天记;可在日期处修改`,
        );
      }
      if (ids.length === 1) void get().openEntry(ids[0]!).catch(() => undefined);
    },

    async openEntry(id, fromRect) {
      const uid = activeUserId();
      if (!uid) {
        get().showToast('请先登录');
        return;
      }
      const operation = beginOperation(true, uid, id);
      try {
        const entry = await getEntry(id, { signal: operation.controller.signal, userId: uid });
        if (!current(id, operation)) return;
        const blob = entry &&
          (await getEntryImage(id, { signal: operation.controller.signal, userId: uid }));
        if (!current(id, operation)) return;
        if (!entry || !blob) {
          get().showToast('这条记忆好像丢失了');
          return;
        }
        const hasDiary = entry.status === 'done';
        const prevUrl = get().entryBlobUrl;
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        const openedAt = performance.now();
        set({
          view: 'session',
          entryId: id,
          entryCreatedAt: entryTakenAt(entry),
          entryBlobUrl: URL.createObjectURL(blob),
          entryRect: fromRect
            ? { x: fromRect.left, y: fromRect.top, w: fromRect.width, h: fromRect.height }
            : null,
          sandified: false,
          phase: 'loading',
          sessionTab: hasDiary ? 'diary' : 'chat',
          messages: entry.chat,
          imageDescription: entry.imageDescription,
          mood: entry.mood,
          people: entry.people ?? [],
          unknownFaces: entry.unknownFaces ?? 0,
          diary: hasDiary
            ? { title: entry.title, mood: entry.mood, body: entry.diaryText }
            : EMPTY_DIARY,
          interimText: null,
          textHidden: false,
          busy: false,
        });

        const engine = getEngine();
        try {
          engine?.setDust(false);
          engine?.resetZoom();
          if (engine) engine.wheelZoomEnabled = true;
          await setImageSerial(id, operation, blob);
        } catch (error) {
          if (!current(id, operation)) return;
          console.warn('[particles] image load failed', error);
          get().showToast('照片加载失败,稍后再试');
          get().backToTimeline();
          return;
        }
        if (!current(id, operation)) return;
        // Hold the sharp photo until the card→fullscreen zoom lands, then burst it into sand.
        await sleep(Math.max(0, ENTRY_ZOOM_MS + 60 - (performance.now() - openedAt)), operation.controller.signal);
        if (!current(id, operation)) return;
        try {
          getEngine()?.sandify();
          set({ sandified: true });
        } catch (error) {
          console.warn('[particles] sandify failed', error);
        }

        const depthOperation = beginOperation(false, uid);
        void runDepth(id, blob, depthOperation)
          .catch((error) => console.warn('[depth] unhandled run error', error))
          .finally(() => depthOperation.release());

        if (hasDiary) {
          try {
            engine?.dim();
            engine?.setAmbience(moodToAmbience(entry.mood));
          } catch (error) {
            console.warn('[particles] diary ambience failed', error);
          }
          if (current(id, operation)) set({ phase: 'done' });
          return;
        }

        // Resume mid-chat: already has user turns — no server open needed for authority.
        if (entry.chat.some((m) => m.role === 'user')) {
          set({ phase: 'chatting' });
          return;
        }

        // Idempotent session open: server owns analyze + opener write.
        const hasOpener = entry.chat.some((m) => m.role === 'assistant' && m.content.trim());
        set({
          phase: hasOpener ? 'chatting' : 'analyzing',
          busy: !hasOpener,
        });
        if (!current(id, operation)) return;
        const opened = await sessionOpen(id, {}, operation.controller.signal);
        if (!current(id, operation)) return;
        const next = opened.entry;
        const openerText =
          next.chat.find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
        const shouldTypewrite =
          opened.analysis.status !== 'skipped' && openerText.length > 0;
        set({
          messages: shouldTypewrite
            ? next.chat.filter((m) => !(m.role === 'assistant' && m.content === openerText))
            : next.chat,
          imageDescription: next.imageDescription,
          mood: next.mood,
          people: next.people ?? [],
          unknownFaces: next.unknownFaces ?? 0,
          entryCreatedAt: entryTakenAt(next),
          phase: next.status === 'done' ? 'done' : 'chatting',
          busy: true,
        });
        void get().refreshEntryPeople();
        if (shouldTypewrite) {
          await typewrite(id, operation, openerText);
        }
        if (current(id, operation)) set({ busy: false });
      } catch (error) {
        if (!current(id, operation)) return;
        console.warn('[session] open failed', error);
        get().showToast('念念暂时联系不上,稍后再试试');
        get().backToTimeline();
      } finally {
        operation.release();
      }
    },

    async removeEntry(id) {
      try {
        await deleteEntry(id, { userId: activeUserId() });
        if (get().entryId === id) get().backToTimeline();
        get().showToast('已丢弃这条记忆');
      } catch {
        get().showToast('没删掉,稍后再试');
      }
    },

    async sendUserMessage(text) {
      const trimmed = text.trim().slice(0, 4000);
      const { entryId, busy, phase } = get();
      if (!trimmed || !entryId || busy || (phase !== 'chatting' && phase !== 'done')) return;
      const id = entryId;
      const uid = activeUserId();
      if (!uid) return;
      const operation = beginOperation(false, uid);
      const withUser: ChatMessage[] = [...get().messages, { role: 'user', content: trimmed }];
      set({
        messages: [...withUser, { role: 'assistant', content: '' }],
        busy: true,
        interimText: null,
      });
      try {
        // Soft date fix still client-side (PATCH whitelist allows takenAt/dateSource).
        void (async () => {
          try {
            const entry = await getEntry(id, { signal: operation.controller.signal, userId: uid });
            if (!entry || !current(id, operation)) return;
            const parsed = parseChatDate(trimmed, {
              ref: entry.uploadedAt || entry.takenAt || Date.now(),
            });
            if (!parsed || !shouldApplyChatDate(entry.dateSource, parsed.kind)) return;
            const prev = entryTakenAt(entry);
            if (
              toYearMonth(prev) === toYearMonth(parsed.takenAt) &&
              new Date(prev).getDate() === new Date(parsed.takenAt).getDate() &&
              new Date(prev).getFullYear() === new Date(parsed.takenAt).getFullYear()
            )
              return;
            await updateEntry(
              id,
              {
                takenAt: parsed.takenAt,
                createdAt: parsed.takenAt,
                yearMonth: toYearMonth(parsed.takenAt),
                dateSource: 'chat',
              },
              { signal: operation.controller.signal, userId: uid },
            );
            if (current(id, operation)) {
              set({ entryCreatedAt: parsed.takenAt });
              get().showToast(`已记到 ${formatDate(parsed.takenAt)},不对可点日期改`);
            }
          } catch (error) {
            if (!operation.controller.signal.aborted) console.warn('[chat] date fix failed', error);
          }
        })().catch((error) => console.warn('[chat] date task failed', error));

        await sessionMessage(
          id,
          trimmed,
          (t) => setLastAssistant(id, operation, t),
          operation.controller.signal,
        );
        if (!current(id, operation)) return;
        const authoritative = await getEntry(id, {
          signal: operation.controller.signal,
          userId: uid,
        });
        if (!current(id, operation)) return;
        if (authoritative) {
          set({
            messages: authoritative.chat,
            entryCreatedAt: entryTakenAt(authoritative),
            busy: false,
          });
        } else {
          set({ busy: false });
        }
      } catch (error) {
        if (!current(id, operation)) return;
        console.warn('[chat] stream failed', error);
        try {
          const authoritative = await getEntry(id, {
            signal: operation.controller.signal,
            userId: uid,
          });
          if (current(id, operation) && authoritative) {
            set({ messages: authoritative.chat, busy: false });
          } else if (current(id, operation)) {
            set({ busy: false });
          }
        } catch {
          if (current(id, operation)) set({ busy: false });
        }
        get().showToast('这句话没送到,再说一次?');
      } finally {
        operation.release();
      }
    },

    async refreshEntryPeople() {
      const id = get().entryId;
      if (!id) return;
      const uid = activeUserId();
      if (!uid) return;
      const operation = beginOperation(false, uid);
      try {
        const entry = await getEntry(id, {
          signal: operation.controller.signal,
          userId: uid,
        });
        if (!entry || !current(id, operation)) return;
        set({ people: entry.people ?? [], unknownFaces: entry.unknownFaces ?? 0 });
      } catch (error) {
        if (!operation.controller.signal.aborted) console.warn('[people] refresh failed', error);
      } finally {
        operation.release();
      }
    },

    async saveDiaryEdits(title, body) {
      const { entryId, diary } = get();
      if (!entryId) return;
      const id = entryId;
      const uid = activeUserId();
      if (!uid) return;
      const operation = beginOperation(false, uid);
      const previous = diary;
      const nextTitle = title.trim().slice(0, 200) || '未命名记忆';
      const nextBody = body.trim().slice(0, 20_000);
      set({ diary: { title: nextTitle, mood: diary.mood, body: nextBody } });
      try {
        await updateEntry(
          id,
          { title: nextTitle, diaryText: nextBody },
          { signal: operation.controller.signal, userId: uid },
        );
      } catch (error) {
        if (current(id, operation)) {
          set({ diary: previous });
          console.warn('[diary] edit save failed', error);
          get().showToast('改动没存上,稍后再试');
        }
      } finally {
        operation.release();
      }
    },

    async setEntryTakenAt(ts) {
      const { entryId } = get();
      if (!entryId || !Number.isFinite(ts) || ts <= 0) return;
      const id = entryId;
      const uid = activeUserId();
      if (!uid) return;
      const operation = beginOperation(false, uid);
      const takenAt = ts;
      try {
        await updateEntry(
          id,
          {
            takenAt,
            createdAt: takenAt,
            yearMonth: toYearMonth(takenAt),
            dateSource: 'manual',
          },
          { signal: operation.controller.signal, userId: uid },
        );
        if (current(id, operation)) {
          set({ entryCreatedAt: takenAt });
          get().showToast(`已改到 ${formatDate(takenAt)}`);
        }
      } catch (error) {
        if (current(id, operation)) {
          console.warn('[entry] date save failed', error);
          get().showToast('日期没存上,稍后再试');
        }
      } finally {
        operation.release();
      }
    },

    async generateDiary() {
      const { entryId, busy, messages, phase } = get();
      if (!entryId || busy || !messages.some((m) => m.role === 'user')) return;
      const id = entryId;
      const uid = activeUserId();
      if (!uid) return;
      const operation = beginOperation(false, uid);
      const initialMood = get().mood;
      const force = phase === 'done';
      set({ phase: 'condensing', busy: true, interimText: null });
      const engine = getEngine();
      try {
        engine?.dissolveText(messages.slice(-8).map((m) => m.content));
        engine?.condense();
      } catch (error) {
        console.warn('[particles] condense failed', error);
      }
      try {
        const result = await sessionComplete(
          id,
          (raw) => {
            if (!current(id, operation)) return;
            const p = parseDiaryStream(raw);
            if (p.headerDone && get().phase === 'condensing') {
              set({ phase: 'revealing', sessionTab: 'diary' });
              try {
                getEngine()?.dim();
                getEngine()?.setAmbience(moodToAmbience(p.mood || initialMood));
              } catch (error) {
                console.warn('[particles] diary reveal failed', error);
              }
            }
            if (current(id, operation)) {
              set({ diary: { title: p.title, mood: p.mood, body: p.body } });
            }
          },
          operation.controller.signal,
          { force },
        );
        if (!current(id, operation)) return;

        // Idempotent skip: the server handed back the finished entry as plain JSON —
        // its fields are final values, so they must NOT go through parseDiaryStream.
        const skippedDiary = result.skipped ? (result.entry.diaryText ?? '').trim() : '';
        if (result.skipped && skippedDiary) {
          const mood = result.entry.mood || initialMood;
          if (get().phase === 'condensing') {
            try {
              getEngine()?.dim();
              getEngine()?.setAmbience(moodToAmbience(mood));
            } catch (error) {
              console.warn('[particles] diary dim failed', error);
            }
          }
          set({
            phase: 'done',
            busy: false,
            sessionTab: 'diary',
            mood,
            diary: {
              title: result.entry.title || '未命名记忆',
              mood,
              body: skippedDiary,
            },
          });
          return;
        }

        const full = result.skipped ? '' : result.full;
        // Authority from server entry (skip payload above may have lacked a diary).
        const authoritative = await getEntry(id, {
          signal: operation.controller.signal,
          userId: uid,
        });
        if (!current(id, operation)) return;
        if (authoritative?.status === 'done') {
          if (get().phase === 'condensing') {
            try {
              getEngine()?.dim();
            } catch (error) {
              console.warn('[particles] diary dim failed', error);
            }
          }
          set({
            phase: 'done',
            busy: false,
            sessionTab: 'diary',
            mood: authoritative.mood || initialMood,
            diary: {
              title: authoritative.title || '未命名记忆',
              mood: authoritative.mood || initialMood,
              body: authoritative.diaryText,
            },
          });
        } else if (full.trim()) {
          const p = parseDiaryStream(full);
          set({
            phase: 'done',
            busy: false,
            sessionTab: 'diary',
            diary: {
              title: p.title || '未命名记忆',
              mood: p.mood || initialMood,
              body: (p.headerDone ? p.body : full).trim(),
            },
          });
        } else {
          throw new Error('empty diary stream');
        }
      } catch (error) {
        if (!current(id, operation)) return;
        console.warn('[diary] generation failed', error);
        // Re-condense of an already-done entry should not hide diary UI.
        const fallbackPhase = force ? 'done' : 'chatting';
        // Try to re-sync from server. Every step after an await re-checks current():
        // the user may have switched entries while getEntry was in flight, and a stale
        // write here would put this entry's diary into the new session.
        try {
          const authoritative = await getEntry(id, {
            signal: operation.controller.signal,
            userId: uid,
          });
          if (!current(id, operation)) return;
          if (authoritative?.status === 'done' && authoritative.diaryText?.trim()) {
            set({
              phase: 'done',
              busy: false,
              sessionTab: 'diary',
              mood: authoritative.mood || initialMood,
              diary: {
                title: authoritative.title || '未命名记忆',
                mood: authoritative.mood || initialMood,
                body: authoritative.diaryText,
              },
            });
            get().showToast('日记没写成,已保留上一版');
            return;
          }
        } catch {
          // fall through
        }
        if (!current(id, operation)) return;
        set({ phase: fallbackPhase, busy: false });
        if (fallbackPhase === 'chatting') {
          try {
            getEngine()?.undim();
          } catch (engineError) {
            console.warn('[particles] diary undim failed', engineError);
          }
        }
        get().showToast('日记没写成,休息一下再试');
      } finally {
        operation.release();
      }
    },

    backToTimeline() {
      invalidateSession();
      const prevUrl = get().entryBlobUrl;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      set({
        view: 'timeline',
        entryId: null,
        entryBlobUrl: null,
        entryRect: null,
        entryCreatedAt: 0,
        sandified: false,
        phase: 'idle',
        imageDescription: '',
        mood: '',
        sessionTab: 'chat',
        messages: [],
        people: [],
        unknownFaces: 0,
        diary: EMPTY_DIARY,
        interimText: null,
        textHidden: false,
        busy: false,
      });
      const engine = getEngine();
      engine?.hidePhoto();
      engine?.setDust(true);
      engine?.resetZoom();
      if (engine) engine.wheelZoomEnabled = false;
    },

    setSessionTab(tab) {
      set({ sessionTab: tab });
      const engine = getEngine();
      if (get().phase === 'done' || get().phase === 'revealing') {
        if (tab === 'diary') {
          engine?.dim();
          engine?.setAmbience(moodToAmbience(get().diary.mood || get().mood));
        } else {
          engine?.undim();
          engine?.setAmbience('none');
        }
      }
    },

    setInterim(text) {
      set({ interimText: text });
    },

    setInputMode(mode) {
      set({ inputMode: mode });
    },

    toggleTextHidden() {
      set((s) => ({ textHidden: !s.textHidden }));
    },

    showToast(msg, kind = 'info') {
      const token = ++toastToken;
      set({ toast: msg, toastKind: kind });
      setTimeout(() => {
        if (toastToken === token) set({ toast: null });
      }, 3200);
    },
  };
});

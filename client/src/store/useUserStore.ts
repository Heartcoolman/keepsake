import { create } from 'zustand';
import {
  bootstrapAuth,
  fetchHealth,
  fetchSession,
  loginAuth,
  logoutAuth,
  recoverAccount,
  registerAuth,
  unlockAuth,
  type AuthedResult,
  type FamilySummary,
  type RegisterInput,
} from '../lib/api';
import {
  ApiError,
  clearSession,
  friendlyError,
  getCurrentUser,
  loadSessionFromStorage,
  onAuthLost,
  onKeysLocked,
  setSession,
  type AuthUser,
} from '../lib/http';
import { revokeAllMedia } from '../lib/media';
import { migrateLegacyData, refreshEntries, setEntriesViewUser } from '../lib/db';
import { startChangeFeed, stopChangeFeed } from '../lib/changeFeed';

export type AuthMode = 'loading' | 'bootstrap' | 'login' | 'locked' | 'ready';

interface UserState {
  mode: AuthMode;
  user: AuthUser | null;
  family: FamilySummary | null;
  /** @deprecated use user.id — kept for activeUserId() callers */
  activeUserId: string | null;
  /** people-with-isUser leftover; empty under v1 accounts */
  users: { id: string; name: string }[];
  pickerOpen: boolean;
  error: string | null;
  /** One-shot recovery code awaiting user acknowledgement (registration/first login). */
  recoveryCode: string | null;
  load: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  bootstrap: (username: string, password: string, displayName?: string, familyName?: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  recover: (username: string, recoveryCode: string, newPassword: string) => Promise<void>;
  ackRecoveryCode: () => void;
  showRecoveryCode: (code: string) => void;
  logout: () => Promise<void>;
  openPicker: () => void;
  closePicker: () => void;
  refresh: () => Promise<void>;
  /** Soft logout when refresh token is rejected. */
  forceLogin: (reason?: string) => void;
}

/** Wipe every trace of the previous account: tokens, cached media blob URLs, the entries
 *  view, and any open per-user overlay/state. Used by both logout and refresh-loss. */
function clearUserScopedState(): void {
  clearSession();
  stopChangeFeed();
  revokeAllMedia();
  setEntriesViewUser(undefined);
  void import('./usePeopleStore').then(({ usePeopleStore }) =>
    usePeopleStore.setState({ people: [], open: false }),
  );
  void import('./useProfileStore').then(({ useProfileStore }) =>
    useProfileStore.getState().closeOverlay(),
  );
  void import('./useReviewStore').then(({ useReviewStore }) =>
    useReviewStore.getState().closeOverlay(),
  );
  void import('./useAppStore').then(({ useAppStore }) => useAppStore.getState().backToTimeline());
}

/** Store fields for an authenticated user — shared by load/login/bootstrap. */
function readyState(user: AuthUser): Pick<
  UserState,
  'mode' | 'user' | 'activeUserId' | 'users' | 'pickerOpen'
> {
  return {
    mode: 'ready',
    user,
    activeUserId: user.id,
    users: [{ id: user.id, name: user.displayName }],
    pickerOpen: false,
  };
}

function onAuthed(user: AuthUser): void {
  setEntriesViewUser(user.id);
  startChangeFeed(user.id);
  void (async () => {
    try {
      const moved = await migrateLegacyData(user.id);
      if (moved) {
        const { useAppStore } = await import('./useAppStore');
        useAppStore.getState().showToast(`已把 ${moved} 条本地记忆搬到服务器`);
      }
    } catch {
      // migration best-effort
    }
    void refreshEntries({ userId: user.id });
    void import('./usePeopleStore').then(({ usePeopleStore }) => usePeopleStore.getState().refresh());
  })();
}

export const useUserStore = create<UserState>((set, get) => {
  // Wire http layer → store so expired refresh clears "ready" UI.
  onAuthLost(() => {
    get().forceLogin('登录已过期,请重新登录');
  });
  // Server restarted and lost its in-memory keys: ask for the password, keep the session.
  onKeysLocked(() => {
    if (get().mode === 'ready') set({ mode: 'locked', pickerOpen: true, error: null });
  });

  /** Shared authenticated-entry flow: install session, surface the recovery code, go ready. */
  async function enterSession(
    authenticate: () => Promise<AuthedResult>,
    fallbackError: string,
    overrides?: Record<string, string>,
  ): Promise<void> {
    set({ error: null });
    try {
      const { session, recoveryCode } = await authenticate();
      setSession(session);
      set({ ...readyState(session.user), recoveryCode: recoveryCode ?? null });
      onAuthed(session.user);
      void get().refresh();
    } catch (e) {
      // A locked keyring mid-login is not an expected state; never leave error empty here.
      set({ error: friendlyError(e, fallbackError, overrides) ?? fallbackError });
      throw e;
    }
  }

  return {
    mode: 'loading',
    user: null,
    family: null,
    activeUserId: null,
    users: [],
    pickerOpen: false,
    error: null,
    recoveryCode: null,

    forceLogin(reason) {
      clearUserScopedState();
      set({
        mode: 'login',
        user: null,
        family: null,
        activeUserId: null,
        users: [],
        pickerOpen: true,
        error: reason ?? null,
      });
    },

    async load() {
      set({ mode: 'loading', error: null });
      loadSessionFromStorage();
      let health: { bootstrapped: boolean };
      try {
        health = await fetchHealth();
      } catch {
        set({ mode: 'login', error: '连不上服务器', pickerOpen: true });
        return;
      }
      if (!health.bootstrapped) {
        clearSession();
        set({ mode: 'bootstrap', user: null, activeUserId: null, pickerOpen: true });
        return;
      }
      const cached = getCurrentUser();
      let loginError: string | null = null;
      if (cached) {
        try {
          const me = await fetchSession();
          if (me.locked) {
            // valid session, server keyring empty — unlock instead of re-login
            set({ mode: 'locked', user: me.user, family: me.family, activeUserId: me.user.id, pickerOpen: true });
            return;
          }
          set({ ...readyState(me.user), family: me.family });
          onAuthed(me.user);
          return;
        } catch (e) {
          // Only a definite auth rejection (refresh already retried inside apiFetch)
          // may wipe the stored session; network errors / 5xx keep the cached user
          // so a flaky server doesn't force a re-login.
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            clearSession();
            loginError = '登录已过期,请重新登录';
          } else {
            set(readyState(cached));
            onAuthed(cached);
            return;
          }
        }
      }
      set({ mode: 'login', user: null, activeUserId: null, pickerOpen: true, error: loginError });
    },

    async login(username, password) {
      await enterSession(() => loginAuth(username, password), '登录失败', {
        UNAUTHORIZED: '用户名或密码不正确',
        VALIDATION: '用户名或密码格式不正确',
      });
    },

    async bootstrap(username, password, displayName, familyName) {
      await enterSession(() => bootstrapAuth(username, password, displayName, familyName), '初始化失败', {
        CONFLICT: '用户名已被占用',
        VALIDATION: '用户名需 3-32 位字母/数字/下划线,密码至少 8 位',
      });
    },

    async register(input) {
      await enterSession(() => registerAuth(input), '注册失败', {
        CONFLICT: '用户名已被占用',
        VALIDATION: '用户名需 3-32 位字母/数字/下划线,密码至少 8 位',
      });
    },

    async unlock(password) {
      set({ error: null });
      try {
        const { recoveryCode } = await unlockAuth(password);
        const user = get().user ?? getCurrentUser();
        if (user) {
          set({ ...readyState(user), recoveryCode: recoveryCode ?? null });
          onAuthed(user);
          void get().refresh();
        }
      } catch (e) {
        set({ error: friendlyError(e, '解锁失败', { UNAUTHORIZED: '密码不正确' }) ?? '解锁失败' });
        throw e;
      }
    },

    async recover(username, recoveryCode, newPassword) {
      await enterSession(() => recoverAccount(username, recoveryCode, newPassword), '找回失败', {
        UNAUTHORIZED: '恢复码不正确',
        NOT_FOUND: '用户名不存在',
      });
    },

    ackRecoveryCode() {
      set({ recoveryCode: null });
    },

    showRecoveryCode(code) {
      set({ recoveryCode: code });
    },

    async logout() {
      await logoutAuth();
      clearUserScopedState();
      set({
        mode: 'login',
        user: null,
        family: null,
        activeUserId: null,
        users: [],
        pickerOpen: true,
      });
    },

    openPicker() {
      set({ pickerOpen: true });
    },

    closePicker() {
      if (get().mode === 'ready') set({ pickerOpen: false });
    },

    async refresh() {
      if (get().mode !== 'ready') return;
      try {
        const me = await fetchSession();
        set({
          user: me.user,
          family: me.family,
          activeUserId: me.user.id,
          users: [{ id: me.user.id, name: me.user.displayName }],
        });
      } catch {
        // stay on cached user
      }
    },
  };
});

export const activeUserId = (): string => useUserStore.getState().activeUserId ?? '';

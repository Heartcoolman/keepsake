import { useEffect, useRef, useState } from 'react';
import { useDialog } from '../lib/useDialog';
import { useAppStore } from '../store/useAppStore';
import { useUserStore } from '../store/useUserStore';
import { useProfileStore } from '../store/useProfileStore';
import { FamilyPanel, PasswordEditor, RecoveryCodeViewer } from './AccountManager';
import type { RegisterInput } from '../lib/api';

/** Programmatic selection fallback when navigator.clipboard is unavailable
 *  (e.g. plain-HTTP LAN deploys) or the write itself fails. */
function selectCodeText(el: HTMLElement | null): void {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** One-shot recovery code display — must be acknowledged, it is never shown again. */
function RecoveryCodeModal() {
  const code = useUserStore((s) => s.recoveryCode);
  const ack = useUserStore((s) => s.ackRecoveryCode);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const armedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(copiedTimer.current);
      window.clearTimeout(armedTimer.current);
    };
  }, []);

  if (!code) return null;

  const copy = () => {
    const onFail = () => {
      selectCodeText(codeRef.current);
      useAppStore.getState().showToast('复制失败,请手动长按复制', 'error');
    };
    if (!navigator.clipboard) {
      onFail();
      return;
    }
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(onFail);
  };

  const dismiss = () => {
    if (armed) {
      window.clearTimeout(armedTimer.current);
      setArmed(false);
      ack();
      return;
    }
    setArmed(true);
    armedTimer.current = window.setTimeout(() => setArmed(false), 3000);
  };

  return (
    <div className="review-overlay" role="presentation" style={{ zIndex: 300 }}>
      <div className="user-panel" role="dialog" aria-modal="true" aria-label="恢复码">
        <div className="user-heading">✦ 你的恢复码</div>
        <p className="user-hint">
          忘记密码时,这是找回记忆的唯一方式。请立刻抄写或保存——它不会再次显示,服务器上也没有任何人能帮你找回。
        </p>
        <div ref={codeRef} className="recovery-code" style={{
          fontFamily: 'monospace', fontSize: 15, letterSpacing: 1, lineHeight: 1.8,
          padding: '12px 14px', border: '1px solid rgba(255,255,255,.2)', borderRadius: 10,
          userSelect: 'all', wordBreak: 'break-all', margin: '10px 0',
        }}>
          {code}
        </div>
        <div className="user-form">
          <button className="chip" onClick={copy}>
            {copied ? '已复制 ✓' : '复制恢复码'}
          </button>
          <button className="pill-btn" onClick={dismiss}>
            {armed ? '再点一次,确认已保存' : '我已妥善保存 ✦'}
          </button>
        </div>
      </div>
    </div>
  );
}

type GateView = 'login' | 'register' | 'recover';

/** Auth gate (bootstrap/login/register/recover/unlock) + account menu when ready. */
export function UserPickerOverlay() {
  const mode = useUserStore((s) => s.mode);
  const open = useUserStore((s) => s.pickerOpen);
  const user = useUserStore((s) => s.user);
  const error = useUserStore((s) => s.error);
  const login = useUserStore((s) => s.login);
  const bootstrap = useUserStore((s) => s.bootstrap);
  const register = useUserStore((s) => s.register);
  const unlock = useUserStore((s) => s.unlock);
  const recover = useUserStore((s) => s.recover);
  const logout = useUserStore((s) => s.logout);
  const closePicker = useUserStore((s) => s.closePicker);

  const [view, setView] = useState<GateView>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [accountType, setAccountType] = useState<'family' | 'personal'>('personal');
  const [regCode, setRegCode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [saving, setSaving] = useState(false);
  // Only the account menu is dismissable; the login/bootstrap gate must not Esc-close.
  const panelRef = useDialog(mode === 'ready', closePicker);

  if (mode === 'loading') {
    return (
      <div className="review-overlay">
        <div className="user-panel">
          <div className="user-heading">✦ 念想</div>
          <p className="user-hint">连接中…</p>
        </div>
      </div>
    );
  }

  const blocking = mode === 'bootstrap' || mode === 'login' || mode === 'locked';
  if (!open && !blocking) return <RecoveryCodeModal />;

  const run = async (task: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    try {
      await task();
    } catch {
      // error in store
    } finally {
      setSaving(false);
    }
  };

  if (mode === 'locked') {
    return (
      <>
        <RecoveryCodeModal />
        <div className="review-overlay" role="presentation">
          <div className="user-panel" role="dialog" aria-modal="true" aria-label="解锁">
            <div className="user-heading">✦ 需要解锁</div>
            <p className="user-hint">
              服务器重启后,你的加密密钥已从内存清除。输入密码重新解锁
              {user ? `(@${user.username})` : ''}。
            </p>
            <div className="user-form">
              <input
                autoFocus
                type="password"
                value={password}
                maxLength={128}
                placeholder="密码"
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && password.length >= 8 && void run(() => unlock(password))}
              />
              {error && <p className="user-hint" style={{ color: '#f88' }}>{error}</p>}
              <button
                className="pill-btn"
                disabled={password.length < 8 || saving}
                onClick={() => void run(() => unlock(password))}
              >
                {saving ? '…' : '解锁 ✦'}
              </button>
              <button className="chip" onClick={() => void logout()}>退出登录</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (mode === 'ready' && user) {
    return (
      <>
        <RecoveryCodeModal />
        <div className="review-overlay" onClick={closePicker} role="presentation">
          <div
            className="user-panel user-panel--accounts"
            ref={panelRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`${user.displayName} 的账户`}
          >
            <div className="user-heading">✦ {user.displayName}</div>
            <p className="user-hint">
              @{user.username} · {user.accountType === 'family' ? '家庭账户' : '个人账户'}
            </p>
            <button
              className="chip profile-link"
              onClick={() => {
                closePicker();
                useProfileStore.getState().openOverlay();
              }}
            >
              ✦ 看看念念眼中的你
            </button>
            <FamilyPanel />
            <PasswordEditor />
            <RecoveryCodeViewer />
            <button
              className="pill-btn"
              style={{ marginTop: 12 }}
              onClick={() => void logout()}
            >
              退出登录
            </button>
            <button className="icon-btn review-close" title="关闭" onClick={closePicker}>
              ✕
            </button>
          </div>
        </div>
      </>
    );
  }

  // ---------- login / bootstrap / register / recover gate ----------

  const isBootstrap = mode === 'bootstrap';
  const activeView: GateView = isBootstrap ? 'register' : view;

  const submitLogin = () => run(() => login(username.trim(), password));
  const submitBootstrap = () =>
    run(() => bootstrap(username.trim(), password, displayName.trim() || undefined, familyName.trim() || undefined));
  const submitRegister = () => {
    const input: RegisterInput = {
      accountType,
      username: username.trim(),
      password,
      displayName: displayName.trim() || undefined,
      familyName: accountType === 'family' ? familyName.trim() || undefined : undefined,
      regCode: regCode.trim() || undefined,
    };
    return run(() => register(input));
  };
  const submitRecover = () =>
    run(() => recover(username.trim(), recoveryInput.trim(), password));

  const heading = isBootstrap
    ? '✦ 首次启用'
    : activeView === 'register'
      ? '✦ 注册账户'
      : activeView === 'recover'
        ? '✦ 用恢复码找回'
        : '✦ 登录念想';

  return (
    <>
      <RecoveryCodeModal />
      <div className="review-overlay" role="presentation">
        <div
          className="user-panel"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={heading}
        >
          <div className="user-heading">{heading}</div>
          <p className="user-hint">
            {isBootstrap
              ? '创建第一个家庭账户,记忆将加密存放——连服务器管理者也读不到'
              : activeView === 'register'
                ? '家庭账户可以创建家庭并邀请他人;个人账户免费独立使用,也能接受家庭邀请'
                : activeView === 'recover'
                  ? '输入注册时保存的恢复码,并设置新密码'
                  : '输入用户名与密码'}
          </p>
          <div className="user-form">
            {activeView === 'register' && !isBootstrap && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="chip"
                  style={accountType === 'personal' ? { borderColor: '#fff' } : undefined}
                  onClick={() => setAccountType('personal')}
                >
                  个人账户
                </button>
                <button
                  className="chip"
                  style={accountType === 'family' ? { borderColor: '#fff' } : undefined}
                  onClick={() => setAccountType('family')}
                >
                  家庭账户
                </button>
              </div>
            )}
            {activeView === 'register' && (
              <input
                value={displayName}
                maxLength={20}
                placeholder="怎么称呼你?"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
            {activeView === 'register' && (isBootstrap || accountType === 'family') && (
              <input
                value={familyName}
                maxLength={20}
                placeholder="家庭名称 (可选)"
                onChange={(e) => setFamilyName(e.target.value)}
              />
            )}
            <input
              autoFocus
              value={username}
              maxLength={32}
              placeholder="用户名 (字母数字_)"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
            {activeView === 'recover' && (
              <input
                value={recoveryInput}
                maxLength={48}
                placeholder="恢复码 (XXXX-XXXX-…)"
                onChange={(e) => setRecoveryInput(e.target.value)}
              />
            )}
            <input
              type="password"
              value={password}
              maxLength={128}
              placeholder={activeView === 'recover' ? '新密码 (至少 8 位)' : '密码 (至少 8 位)'}
              autoComplete={activeView === 'login' ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (activeView === 'login') void submitLogin();
              }}
            />
            {activeView === 'register' && !isBootstrap && (
              <input
                value={regCode}
                maxLength={64}
                placeholder="注册码 (服务器未设置则留空)"
                onChange={(e) => setRegCode(e.target.value)}
              />
            )}
            {error && <p className="user-hint" style={{ color: '#f88' }}>{error}</p>}
            <button
              className="pill-btn"
              disabled={
                saving ||
                !username.trim() ||
                password.length < 8 ||
                (activeView === 'recover' && recoveryInput.trim().length < 8)
              }
              onClick={() => {
                if (isBootstrap) void submitBootstrap();
                else if (activeView === 'register') void submitRegister();
                else if (activeView === 'recover') void submitRecover();
                else void submitLogin();
              }}
            >
              {saving
                ? '…'
                : isBootstrap
                  ? '启用 ✦'
                  : activeView === 'register'
                    ? '注册 ✦'
                    : activeView === 'recover'
                      ? '找回 ✦'
                      : '进入 ✦'}
            </button>
            {!isBootstrap && (
              <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
                {activeView !== 'login' && (
                  <button className="chip" onClick={() => setView('login')}>返回登录</button>
                )}
                {activeView === 'login' && (
                  <>
                    <button className="chip" onClick={() => setView('register')}>注册新账户</button>
                    <button className="chip" onClick={() => setView('recover')}>忘记密码?</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

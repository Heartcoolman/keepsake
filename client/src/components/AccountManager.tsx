import { useEffect, useState } from 'react';
import {
  acceptInvite,
  changeMyPassword,
  createFamily,
  declineInvite,
  fetchFamily,
  fetchMyInvites,
  leaveFamily,
  regenerateRecoveryCode,
  removeFamilyMember,
  revokeFamilyInvite,
  sendFamilyInvite,
  type FamilyInfo,
  type MyInvite,
} from '../lib/api';
import { friendlyError } from '../lib/http';
import { useAppStore } from '../store/useAppStore';
import { useUserStore } from '../store/useUserStore';

const toastError = (error: unknown, fallback: string) => {
  const msg = friendlyError(error, fallback);
  if (msg) useAppStore.getState().showToast(msg, 'error');
};

/** Small in-place confirm dialog, styled like the app's other overlays — replaces native confirm(). */
function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="review-overlay" role="presentation" onClick={onCancel}>
      <div
        className="user-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="确认"
      >
        <p className="user-hint">{message}</p>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 18 }}>
          <button className="chip" onClick={onCancel}>取消</button>
          <button className="pill-btn" onClick={onConfirm}>确认</button>
        </div>
      </div>
    </div>
  );
}

export function PasswordEditor() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!current || next.length < 8 || busy) return;
    setBusy(true);
    try {
      await changeMyPassword(current, next);
      setCurrent('');
      setNext('');
      useAppStore.getState().showToast('密码已修改');
    } catch (error) {
      toastError(error, '密码修改失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-password">
      <div className="profile-label">修改密码</div>
      <input type="password" value={current} placeholder="当前密码" onChange={(e) => setCurrent(e.target.value)} />
      <input type="password" value={next} placeholder="新密码（至少 8 位）" onChange={(e) => setNext(e.target.value)} />
      <button className="chip" disabled={!current || next.length < 8 || busy} onClick={() => void save()}>
        {busy ? '…' : '保存新密码'}
      </button>
    </div>
  );
}

/** Rotate + reveal a fresh recovery code (needs the password; the old code dies). */
export function RecoveryCodeViewer() {
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const view = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const code = await regenerateRecoveryCode(current);
      setCurrent('');
      useUserStore.getState().showRecoveryCode(code);
    } catch (error) {
      toastError(error, '获取恢复码失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-password">
      <div className="profile-label">恢复码</div>
      <p className="user-hint">生成新的恢复码并展示一次(旧码同时失效)。丢了密码和恢复码,数据无人能解。</p>
      <input type="password" value={current} placeholder="当前密码" onChange={(e) => setCurrent(e.target.value)} />
      <button className="chip" disabled={!current || busy} onClick={() => void view()}>
        {busy ? '…' : '生成并查看恢复码'}
      </button>
    </div>
  );
}

/** Family membership panel: owner invites/removes; personal accounts see pending
 *  invites and can leave; standalone personal accounts just see their invites. */
export function FamilyPanel() {
  const user = useUserStore((s) => s.user);
  const [info, setInfo] = useState<FamilyInfo | null>(null);
  const [myInvites, setMyInvites] = useState<MyInvite[]>([]);
  const [inviteName, setInviteName] = useState('');
  const [newFamilyName, setNewFamilyName] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const isOwner = user?.accountType === 'family' && !!user.familyId;
  const inFamily = !!user?.familyId;

  const refresh = async () => {
    try {
      if (inFamily) setInfo(await fetchFamily());
      else setInfo(null);
      if (user?.accountType === 'personal') setMyInvites(await fetchMyInvites());
    } catch {
      // panel is best-effort
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void refresh();
    // re-fetch when membership changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.familyId]);

  const act = async (task: () => Promise<unknown>, key: string, okToast?: string) => {
    if (busyKey !== null) return;
    setBusyKey(key);
    try {
      await task();
      if (okToast) useAppStore.getState().showToast(okToast);
      await useUserStore.getState().refresh();
      await refresh();
      void import('../store/usePeopleStore').then(({ usePeopleStore }) =>
        usePeopleStore.getState().refresh(),
      );
    } catch (error) {
      toastError(error, '操作失败');
    } finally {
      setBusyKey(null);
    }
  };

  if (!user) return null;

  if (!loaded) {
    return (
      <div className="account-manager">
        <p className="user-hint">加载中…</p>
      </div>
    );
  }

  return (
    <div className="account-manager">
      <div className="profile-label">
        {inFamily ? `家庭 · ${info?.family?.name ?? ''}` : '家庭'}
      </div>

      {inFamily && info && (
        <div className="account-list">
          {info.members.map((member) => (
            <div className="account-row" key={member.id}>
              <div>
                <strong>{member.displayName}</strong>
                <small>@{member.username}{member.id === info.family?.ownerId ? ' · 家庭账户' : ''}</small>
              </div>
              {isOwner && member.id !== user.id && (
                <button
                  className="chip"
                  disabled={busyKey !== null}
                  onClick={() => {
                    setConfirm({
                      message: `把 ${member.displayName} 移出家庭?其个人数据保留,共享密钥将轮换。`,
                      onConfirm: () => {
                        setConfirm(null);
                        void act(() => removeFamilyMember(member.id), `remove:${member.id}`, '已移出家庭');
                      },
                    });
                  }}
                >
                  {busyKey === `remove:${member.id}` ? '移出…' : '移出'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <>
          {info && info.invites.length > 0 && (
            <div className="account-list">
              {info.invites.map((invite) => (
                <div className="account-row" key={invite.id}>
                  <div><strong>{invite.inviteeName}</strong><small>邀请待接受</small></div>
                  <button
                    className="chip"
                    disabled={busyKey !== null}
                    onClick={() => void act(() => revokeFamilyInvite(invite.id), `revoke:${invite.id}`, '已撤回')}
                  >
                    {busyKey === `revoke:${invite.id}` ? '撤回…' : '撤回'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="account-create">
            <input
              value={inviteName}
              placeholder="邀请个人账户 (用户名)"
              onChange={(e) => setInviteName(e.target.value)}
            />
            <button
              className="pill-btn"
              disabled={!inviteName.trim() || busyKey !== null}
              onClick={() =>
                void act(async () => {
                  await sendFamilyInvite(inviteName.trim());
                  setInviteName('');
                }, 'invite', '邀请已发送')
              }
            >
              {busyKey === 'invite' ? '发出邀请…' : '发出邀请'}
            </button>
            <p className="user-hint">对方需先注册个人账户并登录过一次,接受邀请后即可共享人物库。</p>
          </div>
        </>
      )}

      {user.accountType === 'family' && !inFamily && (
        <div className="account-create">
          <p className="user-hint">你的家庭已解散。可以创建一个新家庭,重新邀请成员。</p>
          <input
            value={newFamilyName}
            maxLength={20}
            placeholder="家庭名称 (可选)"
            onChange={(e) => setNewFamilyName(e.target.value)}
          />
          <button
            className="pill-btn"
            disabled={busyKey !== null}
            onClick={() =>
              void act(async () => {
                await createFamily(newFamilyName.trim() || undefined);
                setNewFamilyName('');
              }, 'create', '家庭已创建')
            }
          >
            {busyKey === 'create' ? '创建家庭 ✦…' : '创建家庭 ✦'}
          </button>
        </div>
      )}

      {user.accountType === 'personal' && !inFamily && (
        <>
          {myInvites.length === 0 && <p className="user-hint">独立使用中。收到家庭邀请会显示在这里。</p>}
          {myInvites.map((invite) => (
            <div className="account-row" key={invite.id}>
              <div>
                <strong>{invite.familyName}</strong>
                <small>{invite.inviterName} 邀请你加入</small>
              </div>
              <button
                className="chip"
                disabled={busyKey !== null}
                onClick={() => void act(() => acceptInvite(invite.id), `accept:${invite.id}`, '已加入家庭')}
              >
                {busyKey === `accept:${invite.id}` ? '接受…' : '接受'}
              </button>
              <button
                className="chip"
                disabled={busyKey !== null}
                onClick={() => void act(() => declineInvite(invite.id), `decline:${invite.id}`, '已拒绝')}
              >
                {busyKey === `decline:${invite.id}` ? '拒绝…' : '拒绝'}
              </button>
            </div>
          ))}
        </>
      )}

      {user.accountType === 'personal' && inFamily && (
        <button
          className="chip"
          disabled={busyKey !== null}
          onClick={() => {
            setConfirm({
              message: '退出家庭?你的照片与日记保留为个人数据,家庭共享的人物库将不再可见。',
              onConfirm: () => {
                setConfirm(null);
                void act(() => leaveFamily(), 'leave', '已退出家庭');
              },
            });
          }}
        >
          {busyKey === 'leave' ? '退出家庭…' : '退出家庭'}
        </button>
      )}

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

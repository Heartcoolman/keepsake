/** 念想运维台。安全纪律:所有用户可控字符串(用户名/昵称/家庭名)一律走
 *  textContent(el() 的文本子节点),绝不 innerHTML;令牌只存 sessionStorage。 */
'use strict';

const TOKEN_KEY = 'nx-ops-token';
const $app = document.getElementById('app');

let operator = null;
let currentTab = 'overview';

// ---------- DOM helpers ----------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : String(child));
  }
  return node;
}

function replace(parent, ...children) {
  parent.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

let toastTimer = null;
function toast(message, isError, sticky) {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { id: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { node.className = ''; }, 3200);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function fmtDuration(seconds) {
  if (seconds >= 86400) return (seconds / 86400).toFixed(1) + ' 天';
  if (seconds >= 3600) return (seconds / 3600).toFixed(1) + ' 小时';
  return Math.round(seconds / 60) + ' 分钟';
}

// ---------- errors ----------

const ERR_TEXT = {
  NETWORK: '连不上服务器,请检查网络',
  UNAUTHORIZED: '认证失败或登录已过期',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '对象不存在或已被删除',
  VALIDATION: '输入不合法,请检查后重试',
  CONFLICT: '操作冲突,请刷新后重试',
  RATE_LIMITED: '尝试次数过多,请稍后再试',
  PAYLOAD_TOO_LARGE: '提交内容过大',
};

/** 服务端英文报错 → 中文;原文只进 console 供排障。 */
function friendly(e, overrides) {
  if (e && e.message) console.warn('[ops]', e.message);
  const code = e && e.code;
  if (overrides && code && overrides[code]) return overrides[code];
  if (code && ERR_TEXT[code]) return ERR_TEXT[code];
  return '服务器开小差了,请稍后再试';
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
/** 镜像服务端账号规则的预校验;返回中文错误或 null。 */
function credsError(username, password) {
  if (!USERNAME_RE.test(username)) return '用户名需 3-32 位字母/数字/下划线';
  if (typeof password !== 'string' || password.length < 8) return '密码至少 8 位';
  return null;
}

// ---------- modals ----------

function showModal({ danger = false, dismissable = true, render }) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'modal-backdrop' });
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(undefined); };
    document.addEventListener('keydown', onKey);
    if (dismissable) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(undefined); });
    const box = el('div', { class: 'modal' + (danger ? ' danger' : '') }, render(close));
    overlay.append(box);
    document.body.append(overlay);
    const input = box.querySelector('input');
    if (input) input.focus();
  });
}

function modalConfirm(message, { danger = true, confirmLabel = '确认' } = {}) {
  return showModal({ danger, render: (close) => [
    el('p', { class: 'modal-text' }, message),
    el('div', { class: 'row modal-actions' },
      el('button', { onclick: () => close(false) }, '取消'),
      el('button', { class: danger ? 'danger solid' : 'primary', onclick: () => close(true) }, confirmLabel),
    ),
  ] }).then((v) => !!v);
}

/** 需输入完全一致的名字才放行的危险操作确认。 */
function modalConfirmTyped(message, expected) {
  return showModal({ danger: true, render: (close) => {
    const input = el('input', { autocomplete: 'off', spellcheck: 'false' });
    const ok = el('button', { class: 'danger solid', disabled: true, onclick: () => close(true) }, '确认执行');
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== expected; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) close(true); });
    return [
      el('p', { class: 'modal-text' }, message),
      el('p', { class: 'muted' }, '输入「' + expected + '」以确认:'),
      input,
      el('div', { class: 'row modal-actions' }, el('button', { onclick: () => close(false) }, '取消'), ok),
    ];
  } }).then((v) => !!v);
}

/** 输入框对话;返回字符串或 undefined(取消)。 */
function modalPrompt(message, { password = false } = {}) {
  return showModal({ render: (close) => {
    const input = el('input', { type: password ? 'password' : 'text', autocomplete: 'off' });
    const submit = () => { if (input.value) close(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return [
      el('p', { class: 'modal-text' }, message),
      input,
      el('div', { class: 'row modal-actions' },
        el('button', { onclick: () => close(undefined) }, '取消'),
        el('button', { class: 'primary', onclick: submit }, '确定'),
      ),
    ];
  } });
}

/** 一次性机密展示(如新注册码):必须点按钮关闭,支持复制与降级选中。 */
function modalSecret(title, secret) {
  return showModal({ dismissable: false, render: (close) => {
    const codeBox = el('div', { class: 'modal-secret' }, secret);
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(codeBox);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const copyBtn = el('button', { class: 'primary', onclick: async () => {
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(secret);
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
      } catch {
        // http LAN 是非安全上下文,clipboard API 不可用 → 选中让用户手动复制
        selectAll();
        toast('复制失败,已选中文本,请按 Ctrl/Cmd+C 手动复制', true);
      }
    } }, '复制');
    return [
      el('p', { class: 'modal-text' }, title),
      codeBox,
      el('p', { class: 'muted' }, '仅显示这一次,请立即妥善保存。'),
      el('div', { class: 'row modal-actions' }, copyBtn, el('button', { onclick: () => close(true) }, '我已保存,关闭')),
    ];
  } });
}

// ---------- API ----------

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch('/api/ops' + path, { ...options, headers });
  } catch (cause) {
    throw Object.assign(new Error('network failure: ' + cause.message), { code: 'NETWORK' });
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/bootstrap')) {
    sessionStorage.removeItem(TOKEN_KEY);
    operator = null;
    renderGate('登录已过期,请重新登录');
    // silent: the gate itself is the message — callers skip their own display
    throw Object.assign(new Error('unauthorized'), { silent: true });
  }
  if (!res.ok) {
    const errBody = body && body.error;
    const msg = (errBody && (errBody.message || errBody)) || 'HTTP ' + res.status;
    throw Object.assign(new Error(String(msg)), {
      code: (errBody && errBody.code) || (res.status >= 500 ? 'INTERNAL' : undefined),
      status: res.status,
    });
  }
  return body;
}

// ---------- gate ----------

function renderGate(notice) {
  let bootstrapMode = false;
  const error = el('div', { class: 'error' });
  if (notice) { error.textContent = notice; }
  const tokenInput = el('input', { type: 'password', placeholder: '引导令牌 (OPS_BOOTSTRAP_TOKEN)', autocomplete: 'off' });
  const username = el('input', { placeholder: '操作员用户名', autocomplete: 'username' });
  const password = el('input', { type: 'password', placeholder: '密码 (至少 8 位)', autocomplete: 'current-password' });
  const hint = el('div', { class: 'hint' }, '运维台没有任何用户密钥:看不到照片与日记,也不能重置用户密码。');
  const submit = el('button', { class: 'primary' }, '进入');
  const toggle = el('button', {
    class: 'small',
    onclick: () => {
      bootstrapMode = !bootstrapMode;
      tokenInput.style.display = bootstrapMode ? '' : 'none';
      submit.textContent = bootstrapMode ? '创建首个操作员' : '进入';
      toggle.textContent = bootstrapMode ? '返回登录' : '首次引导';
      error.textContent = '';
    },
  }, '首次引导');
  tokenInput.style.display = 'none';

  const go = async () => {
    error.textContent = '';
    const name = username.value.trim();
    if (bootstrapMode) {
      if (!tokenInput.value.trim()) { error.textContent = '请输入引导令牌'; return; }
      const bad = credsError(name, password.value);
      if (bad) { error.textContent = bad; return; }
    } else if (!name || !password.value) {
      error.textContent = '请输入用户名与密码';
      return;
    }
    submit.disabled = true;
    try {
      const path = bootstrapMode ? '/auth/bootstrap' : '/auth/login';
      const payload = { username: name, password: password.value };
      if (bootstrapMode) payload.token = tokenInput.value;
      const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
      sessionStorage.setItem(TOKEN_KEY, data.token);
      operator = data.operator;
      renderShell();
    } catch (e) {
      error.textContent = friendly(e, bootstrapMode
        ? { UNAUTHORIZED: '引导令牌不正确', FORBIDDEN: '服务器未配置引导令牌,引导未开放', CONFLICT: '已完成引导,请直接登录' }
        : { UNAUTHORIZED: '用户名或密码不正确' });
    } finally {
      submit.disabled = false;
    }
  };
  submit.addEventListener('click', go);
  for (const input of [tokenInput, username, password])
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  replace($app, el('div', { class: 'gate' },
    el('h1', null, '✦ 念想 · 运维'),
    hint, tokenInput, username, password, error, submit, toggle,
  ));
}

// ---------- shell ----------

const TABS = [
  ['overview', '概览'],
  ['accounts', '账户'],
  ['families', '家庭'],
  ['usage', '用量'],
  ['registration', '注册'],
  ['operators', '操作员'],
  ['audit', '审计'],
];

let $section = null;

function renderShell() {
  const nav = el('nav', { class: 'tabs' }, TABS.map(([id, label]) =>
    el('button', {
      class: id === currentTab ? 'active' : '',
      onclick: (e) => {
        currentTab = id;
        for (const b of nav.children) b.classList.toggle('active', b === e.currentTarget);
        loadTab();
      },
    }, label),
  ));
  $section = el('section', null, el('p', { class: 'muted' }, '加载中…'));
  replace($app,
    el('header', { class: 'bar' },
      el('h1', null, '✦ 念想 · 运维'),
      el('div', { class: 'row' },
        el('span', { class: 'who' }, '操作员 @' + (operator ? operator.username : '')),
        el('button', {
          class: 'small',
          onclick: async () => {
            try { await api('/auth/logout', { method: 'POST' }); } catch { /* already dead */ }
            sessionStorage.removeItem(TOKEN_KEY);
            operator = null;
            renderGate();
          },
        }, '退出'),
      ),
    ),
    nav,
    $section,
  );
  loadTab();
}

async function loadTab() {
  replace($section, el('p', { class: 'muted' }, '加载中…'));
  try {
    if (currentTab === 'overview') await tabOverview();
    else if (currentTab === 'accounts') await tabAccounts();
    else if (currentTab === 'families') await tabFamilies();
    else if (currentTab === 'usage') await tabUsage();
    else if (currentTab === 'registration') await tabRegistration();
    else if (currentTab === 'operators') await tabOperators();
    else if (currentTab === 'audit') await tabAudit();
  } catch (e) {
    if (!e.silent) replace($section,
      el('p', { class: 'error' }, friendly(e)),
      el('button', { class: 'small', style: 'margin-top:8px', onclick: () => loadTab() }, '重试'),
    );
  }
}

/** 包一层:执行写操作 → toast → 重载当前页签;btn 请求期间禁用防双击。 */
async function act(task, okMessage, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = label + '…'; }
  try {
    await task();
    if (okMessage) toast(okMessage);
    await loadTab();
  } catch (e) {
    if (!e.silent) toast(friendly(e), true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------- 概览 ----------

async function tabOverview() {
  const [sys, backups] = await Promise.all([api('/system'), api('/backups')]);
  const diskRows = Object.entries(sys.disk).map(([name, usage]) =>
    el('tr', null,
      el('td', null, name),
      el('td', { class: 'num' }, String(usage.files)),
      el('td', { class: 'num' }, fmtBytes(usage.bytes)),
    ));
  const migrationRows = sys.migration.map((m) =>
    el('tr', null,
      el('td', null, '@' + m.username),
      el('td', null, m.hasCrypto
        ? el('span', { class: 'pill ok' }, '已建密钥')
        : el('span', { class: 'pill warn' }, '待首次登录')),
      el('td', { class: 'num' }, m.legacyEntries
        ? el('span', { class: 'pill warn' }, m.legacyEntries + ' 条未加密')
        : el('span', { class: 'pill ok' }, '全部密文')),
    ));

  replace($section,
    el('div', { class: 'cards' },
      el('div', { class: 'card' }, el('div', { class: 'k' }, '账户 / 家庭'), el('div', { class: 'v' }, sys.counts.accounts + ' / ' + sys.counts.families)),
      el('div', { class: 'card' }, el('div', { class: 'k' }, '条目 / 人物'), el('div', { class: 'v' }, sys.counts.entries + ' / ' + sys.counts.people)),
      el('div', { class: 'card' }, el('div', { class: 'k' }, '内存密钥环(账户/家庭)'), el('div', { class: 'v' }, sys.keyring.unlockedAccounts + ' / ' + sys.keyring.unlockedFamilies)),
      el('div', { class: 'card' }, el('div', { class: 'k' }, '运行时长'), el('div', { class: 'v' }, fmtDuration(sys.uptimeSeconds))),
      el('div', { class: 'card' }, el('div', { class: 'k' }, '内存占用'), el('div', { class: 'v' }, fmtBytes(sys.rssBytes))),
      el('div', { class: 'card' }, el('div', { class: 'k' }, 'Node'), el('div', { class: 'v' }, sys.nodeVersion + (sys.mockAi ? ' · MOCK' : ''))),
    ),
    el('h2', null, '磁盘占用'),
    el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('span', { class: 'muted' }, '统计时间 ' + fmtTime(sys.generatedAt) + '(60 秒缓存)'),
      el('button', { class: 'small', onclick: (e) => act(() => api('/system?refresh=1'), '', e.currentTarget) }, '强制重算'),
      el('button', { class: 'small', onclick: (e) => act(async () => {
        const r = await api('/system/cache/clear', { method: 'POST', body: JSON.stringify({ kind: 'depth' }) });
        toast('已清理 depth 缓存 ' + r.removed + ' 个文件');
      }, '', e.currentTarget) }, '清理深度缓存'),
      el('button', { class: 'small', onclick: (e) => act(async () => {
        const r = await api('/system/cache/clear', { method: 'POST', body: JSON.stringify({ kind: 'analyze' }) });
        toast('已清理 analyze 缓存 ' + r.removed + ' 个文件');
      }, '', e.currentTarget) }, '清理分析缓存'),
    ),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', null, '目录'), el('th', { class: 'num' }, '文件数'), el('th', { class: 'num' }, '大小'))),
      el('tbody', null, diskRows),
    )),
    el('h2', null, '加密迁移状态'),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', null, '账户'), el('th', null, '密钥'), el('th', { class: 'num' }, '存量数据'))),
      el('tbody', null, migrationRows),
    )),
    el('h2', null, '备份(密文数据,恢复需手工文件操作)'),
    el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('button', { onclick: (e) => act(async () => {
        toast('备份中,勿关闭页面…', false, true);
        const b = await api('/backups', { method: 'POST' });
        toast('备份完成:' + b.name + ' (' + fmtBytes(b.bytes) + ')');
      }, '', e.currentTarget) }, '立即备份 data + cache'),
    ),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', null, '名称'), el('th', { class: 'num' }, '大小'), el('th', null, '时间'), el('th', null, ''))),
      el('tbody', null, backups.items.length ? backups.items.map((b) =>
        el('tr', null,
          el('td', null, b.name),
          el('td', { class: 'num' }, fmtBytes(b.bytes)),
          el('td', null, fmtTime(b.createdAt)),
          el('td', null, el('button', { class: 'small danger', onclick: async (e) => {
            const btn = e.currentTarget;
            if (await modalConfirmTyped('删除备份 ' + b.name + '?', b.name))
              act(() => api('/backups/' + encodeURIComponent(b.name), { method: 'DELETE' }), '备份已删除', btn);
          } }, '删除')),
        )) : el('tr', null, el('td', { colspan: '4', class: 'muted' }, '暂无备份'))),
    )),
  );
}

// ---------- 账户 ----------

async function tabAccounts() {
  const data = await api('/accounts');
  const rows = data.items.map((a) => {
    const status = [];
    if (a.disabled) status.push(el('span', { class: 'pill bad' }, '已停用'));
    if (a.unlocked) status.push(el('span', { class: 'pill ok' }, '在线密钥'));
    if (a.migrationPending) status.push(el('span', { class: 'pill warn' }, '迁移中'));
    if (!a.hasCrypto) status.push(el('span', { class: 'pill warn' }, '未建密钥'));
    return el('tr', null,
      el('td', null, el('strong', null, a.displayName), el('div', { class: 'muted' }, '@' + a.username)),
      el('td', null, a.accountType === 'family' ? '家庭账户' : '个人账户'),
      el('td', null, a.familyId ? a.familyName || a.familyId : el('span', { class: 'muted' }, '独立')),
      el('td', { class: 'num' }, String(a.entryCount)),
      el('td', { class: 'num' }, fmtBytes(a.storageBytes)),
      el('td', null, status.length ? status : el('span', { class: 'pill' }, '正常')),
      el('td', null, el('div', { class: 'row' },
        el('button', { class: 'small' + (a.disabled ? '' : ' danger'), onclick: async (e) => {
          const btn = e.currentTarget;
          const next = !a.disabled;
          if (!next || await modalConfirm('停用 @' + a.username + '?其所有会话将立即失效。', { confirmLabel: '停用' }))
            act(() => api('/accounts/' + encodeURIComponent(a.id), { method: 'PATCH', body: JSON.stringify({ disabled: next }) }),
              next ? '已停用' : '已启用', btn);
        } }, a.disabled ? '启用' : '停用'),
        el('button', { class: 'small danger', onclick: async (e) => {
          const btn = e.currentTarget;
          if (a.familyId) { toast('该账户在家庭中:先由家庭主移出,或解散家庭', true); return; }
          if (await modalConfirmTyped('永久删除 @' + a.username + ' 及其全部数据(照片/日记/人物/缓存/用量)?不可恢复!', a.username))
            act(() => api('/accounts/' + encodeURIComponent(a.id), { method: 'DELETE' }), '账户已删除', btn);
        } }, '删除'),
      )),
    );
  });
  replace($section,
    el('p', { class: 'muted' }, '运维台只见结构信息 — 内容均为密文,无法读取,也不能重置用户密码(仅恢复码可找回)。'),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null,
        el('th', null, '账户'), el('th', null, '类型'), el('th', null, '家庭'),
        el('th', { class: 'num' }, '条目'), el('th', { class: 'num' }, '占用'),
        el('th', null, '状态'), el('th', null, '操作'))),
      el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: '7', class: 'muted' }, '暂无账户'))),
    )),
  );
}

// ---------- 家庭 ----------

async function tabFamilies() {
  const data = await api('/families');
  const blocks = data.items.map((f) =>
    el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('strong', null, f.name),
        el('button', { class: 'small danger', onclick: async (e) => {
          const btn = e.currentTarget;
          if (await modalConfirmTyped(
            '解散家庭「' + f.name + '」?\n共享人物库与 ' + f.members.length +
            ' 位成员的人脸建档将永久丢失(密文随密钥一同作废,无法恢复),成员回到独立状态。',
            f.name,
          ))
            act(() => api('/families/' + encodeURIComponent(f.id), { method: 'DELETE' }), '家庭已解散', btn);
        } }, '解散'),
      ),
      el('div', { class: 'muted' }, '创建于 ' + fmtTime(f.createdAt) + (f.pendingInvites ? ' · ' + f.pendingInvites + ' 个待接受邀请' : '')),
      el('div', { style: 'margin-top:8px' }, f.members.map((m) =>
        el('div', null, m.displayName + '(@' + m.username + ')' + (m.id === f.ownerId ? ' · 家庭主' : '')),
      )),
    ));
  replace($section,
    el('p', { class: 'muted' }, '解散是无密钥的紧急操作:共享作用域的密文将被直接删除,成员下次登录后需重新人脸建档。常规成员变动请让家庭主在应用内操作(那条路径会做密钥轮换)。'),
    blocks.length ? blocks : el('p', { class: 'muted' }, '暂无家庭'),
  );
}

// ---------- 用量 ----------

async function tabUsage() {
  const summary = await api('/usage');
  const detail = el('div');
  const showMonth = async (month) => {
    const data = await api('/usage?month=' + encodeURIComponent(month));
    replace(detail,
      el('h2', null, month + ' 明细'),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null,
          el('th', null, '账户'), el('th', { class: 'num' }, '调用'),
          el('th', { class: 'num' }, '输入 tokens'), el('th', { class: 'num' }, '输出 tokens'),
          el('th', { class: 'num' }, '估算调用'))),
        el('tbody', null, data.items.length ? data.items.map((u) =>
          el('tr', null,
            el('td', null, '@' + u.username),
            el('td', { class: 'num' }, String(u.calls)),
            el('td', { class: 'num' }, String(u.promptTokens)),
            el('td', { class: 'num' }, String(u.completionTokens)),
            el('td', { class: 'num' }, String(u.estimatedCalls)),
          )) : el('tr', null, el('td', { colspan: '5', class: 'muted' }, '该月无用量'))),
      )),
    );
  };
  replace($section,
    el('p', { class: 'muted' }, 'AI token 计量(计费预留,当前不限额)。流式响应取不到 usage 时按字符估算并计入「估算调用」。'),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null,
        el('th', null, '月份'), el('th', { class: 'num' }, '调用'),
        el('th', { class: 'num' }, '输入 tokens'), el('th', { class: 'num' }, '输出 tokens'),
        el('th', { class: 'num' }, '活跃账户'), el('th', null, ''))),
      el('tbody', null, summary.months.length ? summary.months.map((m) =>
        el('tr', null,
          el('td', null, m.yearMonth),
          el('td', { class: 'num' }, String(m.calls)),
          el('td', { class: 'num' }, String(m.promptTokens)),
          el('td', { class: 'num' }, String(m.completionTokens)),
          el('td', { class: 'num' }, String(m.accounts)),
          el('td', null, el('button', { class: 'small', onclick: () => showMonth(m.yearMonth).catch((e) => { if (!e.silent) toast(friendly(e), true); }) }, '明细')),
        )) : el('tr', null, el('td', { colspan: '6', class: 'muted' }, '暂无用量记录'))),
    )),
    detail,
  );
  if (summary.months.length) await showMonth(summary.months[0].yearMonth);
}

// ---------- 注册 ----------

async function tabRegistration() {
  const policy = await api('/registration');
  const codeInput = el('input', { placeholder: '新注册码(留空 = 生成随机码)', autocomplete: 'off', style: 'max-width:280px' });
  replace($section,
    el('p', { class: 'muted' },
      '控制 POST /auth/register。此处修改立即生效并覆盖 REGISTRATION_CODE 环境变量;注册码不会回显,请设置后自行妥善分发。首次启用(bootstrap)不受此开关影响 — 它在有任何账户后自动失效。'),
    el('div', { class: 'cards' },
      el('div', { class: 'card' },
        el('div', { class: 'k' }, '开放注册'),
        el('div', { class: 'v' }, policy.open ? '开启' : el('span', { class: 'pill bad' }, '已关闭')),
        el('div', { style: 'margin-top:10px' },
          el('button', { class: policy.open ? 'danger' : 'primary', onclick: (e) =>
            act(() => api('/registration', { method: 'PATCH', body: JSON.stringify({ open: !policy.open }) }),
              policy.open ? '注册已关闭' : '注册已开放', e.currentTarget) },
            policy.open ? '关闭注册' : '开放注册'),
        ),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'k' }, '注册码'),
        el('div', { class: 'v' }, policy.codeRequired ? '已启用' : '未要求'),
        el('div', { class: 'muted' }, '当前策略来源:' + (policy.source === 'ops' ? '运维配置' : '环境变量')),
      ),
    ),
    el('h2', null, '更换注册码'),
    el('div', { class: 'row' },
      codeInput,
      el('button', { onclick: (e) => {
        const code = codeInput.value.trim() ||
          Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
        act(async () => {
          await api('/registration', { method: 'PATCH', body: JSON.stringify({ code }) });
          await modalSecret('新注册码已生效,旧码立即失效:', code);
        }, '注册码已更换', e.currentTarget);
      } }, '设置 / 轮换'),
      el('button', { class: 'danger', onclick: async (e) => {
        const btn = e.currentTarget;
        if (await modalConfirm('取消注册码要求?任何人都可注册(受开关控制)。', { confirmLabel: '取消注册码' }))
          act(() => api('/registration', { method: 'PATCH', body: JSON.stringify({ code: null }) }), '已取消注册码要求', btn);
      } }, '取消注册码'),
    ),
  );
}

// ---------- 操作员 ----------

async function tabOperators() {
  const data = await api('/operators');
  const username = el('input', { placeholder: '新操作员用户名', autocomplete: 'off', style: 'max-width:200px' });
  const password = el('input', { type: 'password', placeholder: '密码 (至少 8 位)', autocomplete: 'new-password', style: 'max-width:200px' });
  const rows = data.items.map((o) =>
    el('tr', null,
      el('td', null, '@' + o.username + (operator && o.id === operator.id ? '(我)' : '')),
      el('td', null, fmtTime(o.createdAt)),
      el('td', null, el('div', { class: 'row' },
        el('button', { class: 'small', onclick: async (e) => {
          const btn = e.currentTarget;
          const next = await modalPrompt('为 @' + o.username + ' 设置新密码(至少 8 位):', { password: true });
          if (next === undefined) return;
          if (next.length < 8) { toast('密码至少 8 位', true); return; }
          act(() => api('/operators/' + encodeURIComponent(o.id) + '/password', { method: 'PATCH', body: JSON.stringify({ password: next }) }),
            '密码已重置,其所有会话已失效', btn);
        } }, '重置密码'),
        el('button', { class: 'small danger', onclick: async (e) => {
          const btn = e.currentTarget;
          const last = data.items.length === 1;
          if (await modalConfirmTyped('删除操作员 @' + o.username + '?' + (last ? '\n这是最后一个操作员:删除后运维台将锁死,须由部署者重新走 OPS_BOOTSTRAP_TOKEN 引导。' : ''), o.username))
            act(() => api('/operators/' + encodeURIComponent(o.id), { method: 'DELETE' }), '操作员已删除', btn);
        } }, '删除'),
      )),
    ));
  replace($section,
    el('p', { class: 'muted' }, '操作员互为对等,可互相建号 / 重置密码 / 删除(全部入审计)。唯一操作员丢失密码时:部署者 ssh 删除 data/ops/ 下的记录,引导即重新开放。'),
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', null, '操作员'), el('th', null, '创建时间'), el('th', null, '操作'))),
      el('tbody', null, rows),
    )),
    el('h2', null, '新增操作员'),
    el('div', { class: 'row' },
      username, password,
      el('button', { onclick: (e) => {
        const bad = credsError(username.value.trim(), password.value);
        if (bad) { toast(bad, true); return; }
        act(async () => {
          await api('/operators', { method: 'POST', body: JSON.stringify({ username: username.value.trim(), password: password.value }) });
          username.value = ''; password.value = '';
        }, '操作员已创建', e.currentTarget);
      } }, '创建'),
    ),
  );
}

// ---------- 审计 ----------

async function tabAudit() {
  const data = await api('/audit?limit=200');
  replace($section,
    el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null,
        el('th', null, '时间'), el('th', null, '操作员'), el('th', null, '动作'),
        el('th', null, '对象'), el('th', null, '备注'))),
      el('tbody', null, data.items.length ? data.items.map((a) =>
        el('tr', null,
          el('td', null, fmtTime(a.ts)),
          el('td', null, '@' + a.opUsername),
          el('td', null, a.action),
          el('td', null, a.target),
          el('td', { class: 'muted' }, a.detail),
        )) : el('tr', null, el('td', { colspan: '5', class: 'muted' }, '暂无记录'))),
    )),
  );
}

// ---------- boot ----------

(async () => {
  if (!sessionStorage.getItem(TOKEN_KEY)) return renderGate();
  try {
    const me = await api('/auth/me');
    operator = me.operator;
    renderShell();
  } catch (e) {
    // api() already routed to the gate on 401
    if (!operator && !document.querySelector('.gate'))
      renderGate(e.code === 'NETWORK' ? ERR_TEXT.NETWORK : undefined);
  }
})();

# 念想 API v1

Base path: `/api/v1`  
Auth: `Authorization: Bearer <accessToken>`（除 bootstrap / login / refresh / health）  
Error shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
```

Codes: `UNAUTHORIZED` | `FORBIDDEN` | `NOT_FOUND` | `VALIDATION` | `CONFLICT` | `RATE_LIMITED` | `PAYLOAD_TOO_LARGE` | `UPSTREAM` | `UNAVAILABLE` | `INTERNAL` | `E_KEYS_LOCKED`

Header: `X-API-Version: 1`

## Accounts & tenancy

- 两类账户：**家庭账户**（`accountType: "family"`，注册即创建家庭，可邀请/移除成员；未来收费位 `plan`）与**个人账户**（`"personal"`，免费独立使用；只能接受邀请或退出家庭）。
- 一台服务器可承载多个互不可见的家庭和任意独立个人账户。
- 用户名全服唯一（login 不带家庭上下文）。
- 没有管理员代设/重置密码：找回只能用注册时展示一次的**恢复码**。

## Isolation

- **Entries** are strictly private: only `ownerId === current user` can list/read/write media/AI.
- Non-owners get **404** (no existence leak).
- **People** registry / relationship graph / face caches are **scope-shared**：作用域 = 所在家庭；独立个人账户自成作用域。跨家庭完全不可见。
- **Unassigned faces** only include faces from the caller's own entries.
- Profile / monthly reviews are per account.

## Encryption at rest & locked state

- 每账户密钥（UDK / X25519 私钥）由登录密码经 scrypt 派生的 KEK 包裹；家庭密钥（FK）以 sealed-box 封给成员公钥。落盘的照片、日记、聊天、人脸特征、人格画像全部为 AES-256-GCM 密文——拿到磁盘/备份的部署者读不到内容。
- 服务端只在会话期间在内存 keyring 中持有明文密钥（滑动 30 天,与 refresh 同寿命）。**服务器重启后**,有效 JWT 也打不开数据：数据路由返回 **423 `E_KEYS_LOCKED`**,客户端应引导用户 `POST /auth/unlock` `{ password }` 重新解锁（无需重新登录）。
- 已知边界：服务端在会话内解密以驱动 AI（人脸/深度/LLM）；恶意修改服务端代码可在用户下次登录后截获密钥。

## Bootstrap & auth

1. `GET /health` → `{ bootstrapped, mock, apiVersion, authRequired }`
2. 首个账户: `POST /auth/bootstrap` `{ username, password, displayName?, familyName? }`（等价注册家庭账户,仅全服零账号时可用）
3. 开放注册: `POST /auth/register` `{ accountType: "family"|"personal", username, password, displayName?, familyName?, regCode? }`。注册策略：`data/ops-config.json`（由 /ops 运维台管理,见 docs/ops.md）一旦存在即完全权威——含开关与注册码,`registrationCode: null` 表示明确不设码,不回落环境变量;该文件不存在时才使用 `REGISTRATION_CODE` env。`/auth/bootstrap` 不受注册开关影响（有任何账户后它自动失效）。
4. Else: `POST /auth/login` `{ username, password }`
5. Response: `{ accessToken, refreshToken, expiresIn, user, recoveryCode? }`——`recoveryCode` 仅在创建账户或旧账户首次登录补建密钥时返回一次,客户端必须立刻展示并要求保存。
6. Refresh: `POST /auth/refresh` `{ refreshToken }`
7. Unlock（重启后）: `POST /auth/unlock` `{ password }`
8. Logout: `POST /auth/logout` (bumps tokenVersion; invalidates outstanding tokens; wipes keyring)
9. 找回: `POST /auth/recover` `{ username, recoveryCode, newPassword }` → 新会话 + 新恢复码
10. 查看/轮换恢复码: `POST /auth/me/recovery-code` `{ currentPassword }` → `{ recoveryCode }`
11. `GET /auth/me` → `{ user, family, migrationPending, locked }`

Password min length: 8.  
Set `JWT_SECRET` (32+ random bytes hex) in production.

## Family & invites

| Method | Path | Notes |
|--------|------|--------|
| GET | `/family` | `{ family, members, invites }`（invites 仅 owner 可见） |
| POST | `/family/invites` | owner；`{ username }`，目标须为未入家庭的个人账户且登录过一次（有公钥）；FK 随邀请密封 |
| DELETE | `/family/invites/:id` | owner 撤回 |
| GET | `/me/invites` | 个人账户的待处理邀请 |
| POST | `/me/invites/:id/accept` | 加入家庭；身份人物迁入家庭作用域，个人人物库休眠 |
| POST | `/me/invites/:id/decline` | |
| POST | `/me/family/leave` | 个人账户退出；**家庭密钥轮换**并重加密共享数据 |
| DELETE | `/family/members/:id` | owner 移除成员（同样触发轮换） |
| GET | `/users` | 同家庭成员列表（独立账户仅返回自己） |

## Entries

| Method | Path | Notes |
|--------|------|--------|
| GET | `/entries/changes?since` | SSE 变更流(见下),仅 requireAuth |
| GET | `/entries?cursor&limit&status&yearMonth` | paginated `{ items, nextCursor }` |
| GET | `/entries/:id` | |
| POST | `/entries` | multipart `meta` + `image` + `thumb` (+ optional `override`); owner forced from token |
| PATCH | `/entries/:id` | **whitelist only** (see below); cannot forge session fields |
| DELETE | `/entries/:id` | |
| GET | `/entries/:id/media/image` | jpeg |
| GET | `/entries/:id/media/thumb` | |
| GET | `/entries/:id/depth` | depth JSON |
| GET | `/entries/:id/faces` | people refs + unknown count |
| GET | `/entries/:id/faces/:idx/thumb` | |

`meta` JSON on create: `{ id, takenAt?, dateSource?, status?, clientUploadId?, ... }`. Server sets `ownerId`.

### Upload idempotency & duplicate hint

- `clientUploadId`(`[A-Za-z0-9._-]{1,128}`,建议 UUID):幂等键。同 owner 重放同一 `clientUploadId` → **200** + 已建 entry(不再新建);创建后不可改。
- 同 owner 上传**相同图片字节**(sha256 命中)且未带 `override` → **409** `DUPLICATE_IMAGE`,body 额外带 `duplicateOf: { id, takenAt }`;客户端确认后带 `override=1` 重发即正常 201 新建。
- 不同账号之间互不去重;entry `id` 冲突仍是 409 `CONFLICT`。

### Change feed(同账号多设备同步)

`GET /entries/changes?since=<seq>`,SSE 长连,**仅 requireAuth**(锁库时仍可开流;事件不含解密内容)。帧类型:

- `{ type: "cursor", seq }` — 连上/补齐后的续传位置
- `{ type: "change", seq, entryId, kind }` — `kind`: `created` | `updated` | `deleted`,仅本账号的 entry
- `{ type: "resync", seq }` — 游标不可补齐(过期/重启),客户端应全量刷新
- `{ type: "ping" }` — 心跳(约 25s)

服务端约每 20 分钟主动关流,客户端带最后 seq 重连(指数退避);收到 change 建议防抖合并后再刷新。

### PATCH whitelist

Allowed: `title`, `diaryText`, `mood`, `takenAt`, `createdAt`, `dateSource`. (`yearMonth` is always derived from `takenAt`.)  
Rejected with `VALIDATION` (examples): `chat`, `imageDescription`, `status`, ownership fields.

Session lifecycle writes (`chat` / opener / `status` chatting|done / analyze description) go through **Session** routes below.

## Session (canonical)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/entries/:id/session/open` | body optional `{ force? }` → `{ entry, analysis }`；幂等 ensure analyze + opener |
| POST | `/entries/:id/session/message` | `{ text }` → **SSE v1**；服务端 append user/assistant |
| POST | `/entries/:id/session/complete` | body optional `{ force? }` → **SSE v1** 生成日记并 `status=done`；已 done 且非 force 时 JSON `{ entry, skipped: true }` |

Open rules: existing non-empty assistant opener → skip LLM (`analysis.status=skipped`); concurrent open does not duplicate opener.  
Message: model history is **server `entry.chat`** only; client must not send messages array. After stream ends, clients should `GET /entries/:id` for authority.  
Complete: server parses diary front-matter (`标题` / `心情` / `---`) and persists title/mood/diaryText/status.

## AI (legacy)

Prefer Session routes for product clients. Legacy routes remain for now:

| Method | Path | Notes |
|--------|------|--------|
| POST | `/entries/:id/analyze` | body optional `{ force? }`；server reads stored image（does not fully own opener chat） |
| POST | `/entries/:id/chat` | `{ messages }` → **SSE v1**（client-supplied history） |
| POST | `/entries/:id/diary` | `{ messages, dateStr?, mood? }` → **SSE v1** |
| GET | `/monthly/:yearMonth` | |
| POST | `/monthly/:yearMonth/generate` | SSE v1 |

Scene people for chat/diary/session are resolved **server-side** from entry + people registry.

### SSE v1 envelope

```
Content-Type: text/event-stream

data: {"type":"delta","text":"片"}

data: {"type":"done"}
```

Stream error frame (then close):

```
data: {"type":"error","code":"UPSTREAM","message":"..."}
```

Clients accumulate `delta.text` into full assistant text.

## People & profile

- `GET/POST /people`, `PATCH/DELETE /people/:id`, `POST /people/:id/merge`
- `GET /faces/unassigned` → `{ items: [{ faces: [{ entryId, faceIndex }] }] }`
- `GET/PATCH /me/profile`, `PATCH/DELETE /me/memories/:memId`
- `GET /config` (auth) — feature flags + upload limit

## Legacy

Web 和 Android 均已迁移至 v1。旧的**无鉴权** `/api/*` 兼容层已移除：所有非 `/api/v1` 的 `/api/*` 一律返回 404。

旧管理员账号管理接口（`POST /users`、`PATCH/DELETE /users/:id`）已删除——成员通过「注册个人账户 + 家庭邀请」加入。移动端旧版的账号管理界面在二期跟进前不可用；登录/条目/会话链路保持兼容（服务器重启后需在 Web 端解锁一次或重新登录）。

## OpenAPI

Machine-readable: `server/openapi/v1.yaml`

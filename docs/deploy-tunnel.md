# 部署：局域网 + 可选公网穿透

## 局域网（默认）

```bash
cp .env.example .env
# 填 XAI_API_KEY 与 JWT_SECRET（openssl rand -hex 32）
pnpm install && pnpm build && pnpm start
# 或开发：pnpm dev  →  server :8787
```

手机与 NAS 同一 Wi‑Fi 时，Android 设置服务器为：

```
http://<NAS局域网IP>:8787
```

模拟器访问本机请用 `http://10.0.2.2:8787`。

## HTTPS / 传输层（强烈建议，安全根因）

**服务默认是纯 HTTP。** 注册/登录/找回的响应体会携带 accessToken、refreshToken，以及
一次性 **recoveryCode**（找回密钥，能重置口令并解密该用户及其家庭的全部数据）。纯 HTTP
下这些都可被同网段嗅探——渗透测试确认的高危账户接管链正源于此。因此：

- **不要在纯 HTTP 下把 8787 暴露到公网或不可信局域网**（合租/公共 Wi‑Fi 等）。
- 生产务必置于 TLS 反代之后（Caddy / nginx）。示例 `Caddyfile`：

```
nianxiang.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

反代启用 TLS 后，配合以下环境变量，让 refresh cookie 带上 `Secure`、并让应用信任
`X-Forwarded-Proto`：

```
JWT_SECRET=<长随机串>
XAI_API_KEY=...
PORT=8787
TRUST_PROXY=1      # 反代跳数（通常 1），否则 X-Forwarded-* 一律不信任
COOKIE_SECURE=1    # 明确告知运行在 TLS 之后，强制 refresh cookie 的 Secure 标志
```

> 安全响应头（CSP 含 `frame-ancestors 'none'`、`X-Frame-Options`、`X-Content-Type-Options`、
> `Referrer-Policy`、`Permissions-Policy`、`Strict-Transport-Security` 等）**由应用自身下发**
> （`server/src/index.ts`），无需在反代重复配置；其中 HSTS 仅在 HTTPS 下生效。

首次打开 Web 或 App → `bootstrap` 创建管理员。设置 `BOOTSTRAP_TOKEN` 可关闭
"首个访问者即管理员" 窗口。

## Docker

见根目录 `docker-compose.yml`。挂载 `./data` 与模型缓存；同样设置 `JWT_SECRET`。

## 安全清单

- [ ] 强密码（≥8）
- [ ] `JWT_SECRET` 已设且备份
- [ ] **暴露前置于 TLS 反代之后**（纯 HTTP 会泄露 token / recoveryCode），并设
      `TRUST_PROXY` 与 `COOKIE_SECURE=1`
- [ ] `BOOTSTRAP_TOKEN` 已设（避免首个访问者接管管理员）
- [ ] 防火墙只开反代端口（不直接暴露 8787）
- [ ] 定期备份 `server/data/`
- [ ] 提醒用户妥善保管注册时一次性下发的 recoveryCode（唯一的口令找回途径）

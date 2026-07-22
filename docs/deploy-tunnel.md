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

## HTTPS / 公网（推荐 Caddy）

裸 HTTP 不要直接暴露公网。示例 `Caddyfile`：

```
nianxiang.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

环境变量：

```
JWT_SECRET=<长随机串>
XAI_API_KEY=...
PORT=8787
```

首次打开 Web 或 App → `bootstrap` 创建管理员。

## Docker

见根目录 `docker-compose.yml`。挂载 `./data` 与模型缓存；同样设置 `JWT_SECRET`。

## 安全清单

- [ ] 强密码（≥8）
- [ ] `JWT_SECRET` 已设且备份
- [ ] 公网仅 HTTPS
- [ ] 防火墙只开反代端口
- [ ] 定期备份 `server/data/`

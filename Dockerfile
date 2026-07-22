# Stage 1: install the full workspace (dev deps included) and build the web client.
FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN npm install -g pnpm@10 --registry=https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/
COPY server/package.json server/
RUN pnpm config set registry https://registry.npmmirror.com && pnpm install --frozen-lockfile

COPY client client
RUN pnpm --filter @nianxiang/client build

# Stage 2: runtime image with server production deps only — no dev deps, no client toolchain.
FROM node:24-bookworm-slim

WORKDIR /app
RUN npm install -g pnpm@10 --registry=https://registry.npmmirror.com

# client/package.json is needed so the workspace layout matches the lockfile,
# but only the server's production deps get installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/
COPY server/package.json server/
RUN pnpm config set registry https://registry.npmmirror.com \
  && pnpm install --frozen-lockfile --prod --filter @nianxiang/server \
  && pnpm store prune

# server source runs directly under node 24 (type stripping); models ship in the
# image so first startup works offline. data/cache are volume mounts.
COPY server server
COPY --from=build /app/client/dist client/dist

# Non-root runtime. Mounted data/cache dirs must be writable by uid 1000
# (docker-compose.yml pre-creates them via the host directory owner).
RUN mkdir -p server/data server/cache && chown -R node:node /app
USER node

EXPOSE 8787
CMD ["node", "server/src/index.ts"]

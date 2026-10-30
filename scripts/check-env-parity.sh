#!/usr/bin/env bash
# 配置面一致性自检:服务端代码实际读取的环境变量,必须同时出现在 .env.example
# 与 docker-compose.yml 中。三者任一缺项 → 退出码 1。
#
# 由来:代码读 22 个变量时 .env.example 只记 13 个、compose 只透传 13 个,导致
# MATTING_SIDECAR_URL 之类的开关在容器部署下无法设置,推理静默回落本地 CPU。
#
# 白名单:NODE_ENV 由 compose 单方面设定,不出现在代码的 process.env 读取里。

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

grep -rhoE 'process\.env\.[A-Z_0-9]+' server/src --include='*.ts' \
  | sed 's/process\.env\.//' | sort -u > "$tmp/code"
grep -oE '^[A-Z_0-9]+=' .env.example | tr -d '=' | sort -u > "$tmp/example"
grep -oE '^ *- [A-Z_0-9]+=' docker-compose.yml | sed 's/.*- //;s/=//' | sort -u > "$tmp/compose"

fail=0

missing_example=$(comm -23 "$tmp/code" "$tmp/example")
if [[ -n "$missing_example" ]]; then
  echo "ENV: 代码读取但 .env.example 未记录:" >&2
  echo "$missing_example" | sed 's/^/  /' >&2
  fail=1
fi

missing_compose=$(comm -23 "$tmp/code" "$tmp/compose")
if [[ -n "$missing_compose" ]]; then
  echo "ENV: 代码读取但 docker-compose.yml 未透传:" >&2
  echo "$missing_compose" | sed 's/^/  /' >&2
  fail=1
fi

# 反向:文档或 compose 里有、代码已不再读取的变量(删代码时漏删文档)
stale=$(comm -13 "$tmp/code" <(sort -u "$tmp/example" "$tmp/compose") | grep -vx 'NODE_ENV' || true)
if [[ -n "$stale" ]]; then
  echo "ENV: .env.example 或 compose 声明了代码已不读取的变量:" >&2
  echo "$stale" | sed 's/^/  /' >&2
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "env parity OK ($(wc -l < "$tmp/code" | tr -d ' ') 个变量,三处一致)"
fi
exit $fail

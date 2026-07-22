#!/usr/bin/env bash
# push 前泄漏自检:确认公开仓库的 git 索引(即将提交/推送的内容)不含私有 core 内容。
# 基于索引而非工作区,因此在 select-core 私有模式下也能正确运行(skip-worktree 保证
# 索引里仍是公开桩)。任何命中 → 退出码 1。
#
# 敏感内容的特征串本身也是私有信息,所以完整清单放在 core/leak-patterns.txt(私有,
# 每行一个 fixed string);本脚本只内置不泄漏任何信息的通用规则。

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0

# 通用规则:project.yml 里不允许出现任何真实 Apple Team ID(10 位大写字母数字)
hits=$(git grep -lE --cached 'DEVELOPMENT_TEAM: *"?[A-Z0-9]{10}"?' 2>/dev/null || true)
if [[ -n "$hits" ]]; then
  echo "LEAK: 发现疑似真实 DEVELOPMENT_TEAM:" >&2
  echo "$hits" >&2
  fail=1
fi

# 完整特征串清单(仅私有开发者本地可用)
PATTERNS_FILE="$ROOT/core/leak-patterns.txt"
if [[ -f "$PATTERNS_FILE" ]]; then
  while IFS= read -r pat; do
    [[ -z "$pat" || "$pat" == \#* ]] && continue
    hits=$(git grep -lF --cached -- "$pat" 2>/dev/null || true)
    if [[ -n "$hits" ]]; then
      echo "LEAK: 私有特征串命中:" >&2
      echo "$hits" >&2
      fail=1
    fi
  done < "$PATTERNS_FILE"
else
  echo "note: core/leak-patterns.txt 不存在,仅执行了通用规则(公开访客模式)。"
fi

if [[ "$fail" == 0 ]]; then
  echo "check-leaks: OK(索引中未发现私有内容特征)"
fi
exit "$fail"

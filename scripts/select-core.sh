#!/usr/bin/env bash
# 私有开发者专用:把 core/ 子模块(nianxiang-core)的真实实现复制到公开树对应路径,
# 覆盖公开桩文件。公开访客不需要运行此脚本 —— 桩文件本身即可完整构建。
#
# 用法:
#   ./scripts/select-core.sh          # core → 公开树(选用真实实现)
#   ./scripts/select-core.sh --push   # 公开树 → core(把你对核心文件的修改回写,之后到 core/ 里提交)
#   ./scripts/select-core.sh --reset  # 还原公开桩,清理新增文件
#
# 机制:被替换的桩文件是 git 跟踪文件,复制后用 `git update-index --skip-worktree`
# 屏蔽本地差异,`git status` 保持干净,`git add -A` 也不会把真实实现提交进公开仓库。
# 注意:上游若改动了某个桩文件,pull/checkout 会因 skip-worktree 拒绝覆盖 ——
# 先 `--reset`,pull 完再重新运行本脚本。仅从核心文件新增的测试(公开树中原本不存在)
# 走 .git/info/exclude(本地专属,不进仓库)。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/core"

# 「core 内路径 → 公开树路径」;REPLACE=覆盖跟踪的桩文件,ADD=公开树中不存在的新增文件
REPLACE=(
  "server/prompts.ts::server/src/prompts.ts"
  "server/mock.ts::server/src/mock.ts"
  "server/face.ts::server/src/face.ts"
  "server/depth.ts::server/src/depth.ts"
  "server/memory.ts::server/src/memory.ts"
  "server/analyzeEnsure.ts::server/src/session/analyzeEnsure.ts"
  "server/sessionRoutes.ts::server/src/v1/sessionRoutes.ts"
  "client/particles/ParticleEngine.ts::client/src/particles/ParticleEngine.ts"
  "client/particles/depthMath.ts::client/src/particles/depthMath.ts"
  "client/particles/depthWorker.ts::client/src/particles/depthWorker.ts"
  "client/particles/engineRef.ts::client/src/particles/engineRef.ts"
  "client/particles/sampleImage.ts::client/src/particles/sampleImage.ts"
  "client/particles/shaders.ts::client/src/particles/shaders.ts"
  "android/particle/ParticleModels.kt::android/app/src/main/java/com/nianxiang/app/particle/ParticleModels.kt"
  "android/particle/ParticleRenderer.kt::android/app/src/main/java/com/nianxiang/app/particle/ParticleRenderer.kt"
  "android/particle/ParticleSampler.kt::android/app/src/main/java/com/nianxiang/app/particle/ParticleSampler.kt"
  "android/particle/ParticleShaders.kt::android/app/src/main/java/com/nianxiang/app/particle/ParticleShaders.kt"
  "android/particle/ParticleView.kt::android/app/src/main/java/com/nianxiang/app/particle/ParticleView.kt"
  "apple/Particle/ParticleModels.swift::apple/Nianxiang/Particle/ParticleModels.swift"
  "apple/Particle/ParticleRenderer.swift::apple/Nianxiang/Particle/ParticleRenderer.swift"
  "apple/Particle/ParticleSampler.swift::apple/Nianxiang/Particle/ParticleSampler.swift"
  "apple/Particle/ParticleView.swift::apple/Nianxiang/Particle/ParticleView.swift"
  "apple/Particle/Shaders.metal::apple/Nianxiang/Particle/Shaders.metal"
)
ADD=(
  "server/matting.ts::server/src/matting.ts"
  "server/test/session-api.e2e.test.ts::server/test/session-api.e2e.test.ts"
  "server/test/relationships.e2e.test.ts::server/test/relationships.e2e.test.ts"
  "android/test/ParticleRendererTest.kt::android/app/src/androidTest/java/com/nianxiang/app/particle/ParticleRendererTest.kt"
  "android/test/ParticleGestureUiTest.kt::android/app/src/androidTest/java/com/nianxiang/app/ui/ParticleGestureUiTest.kt"
  "apple/test/ParticleSamplerTests.swift::apple/NianxiangTests/ParticleSamplerTests.swift"
)

mode="${1:-select}"

case "$mode" in
  select)
    if [[ ! -f "$CORE/server/prompts.ts" ]]; then
      echo "core/ 子模块为空 —— 先运行: git submodule update --init" >&2
      exit 1
    fi
    for pair in "${REPLACE[@]}"; do
      src="${pair%%::*}"; dst="${pair##*::}"
      cp "$CORE/$src" "$ROOT/$dst"
      git -C "$ROOT" update-index --skip-worktree "$dst"
    done
    EXCLUDE="$ROOT/.git/info/exclude"
    MARK="# select-core.sh managed"
    if ! grep -qF "$MARK" "$EXCLUDE" 2>/dev/null; then
      { echo "$MARK"
        for pair in "${ADD[@]}"; do echo "${pair##*::}"; done
      } >> "$EXCLUDE"
    fi
    for pair in "${ADD[@]}"; do
      src="${pair%%::*}"; dst="${pair##*::}"
      mkdir -p "$ROOT/$(dirname "$dst")"
      cp "$CORE/$src" "$ROOT/$dst"
    done
    echo "core selected: 真实实现已覆盖公开桩(git status 应保持干净)。"
    ;;
  --push)
    for pair in "${REPLACE[@]}" "${ADD[@]}"; do
      src="${pair%%::*}"; dst="${pair##*::}"
      [[ -f "$ROOT/$dst" ]] && cp "$ROOT/$dst" "$CORE/$src"
    done
    echo "已回写到 core/ —— 记得 cd core && git commit,并在公开仓库提交 submodule 指针。"
    ;;
  --reset)
    for pair in "${REPLACE[@]}"; do
      dst="${pair##*::}"
      git -C "$ROOT" update-index --no-skip-worktree "$dst" 2>/dev/null || true
      git -C "$ROOT" checkout -- "$dst" 2>/dev/null || true
    done
    for pair in "${ADD[@]}"; do
      rm -f "$ROOT/${pair##*::}"
    done
    echo "已还原公开桩。"
    ;;
  *)
    echo "用法: $0 [--push|--reset]" >&2
    exit 1
    ;;
esac

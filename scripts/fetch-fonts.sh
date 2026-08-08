#!/usr/bin/env bash
# 下载导出功能(分享卡/年度册)所需的 CJK 字体到 server/assets/fonts/。
# 字体不进 git(体积大、许可 OFL 允许再分发但没必要入库);本地开发与部署主机各跑一次。
# 缺字体时导出端点返回 503 EXPORT_FONTS_MISSING,其余功能不受影响。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/server/assets/fonts"
mkdir -p "$DEST"

fetch() { # $1=url $2=file $3=min-bytes
  if [ -s "$DEST/$2" ] && [ "$(wc -c < "$DEST/$2")" -ge "$3" ]; then
    echo "already present: $2"
    return
  fi
  echo "fetching $2 ..."
  curl -fL --retry 3 -o "$DEST/$2.part" "$1"
  [ "$(wc -c < "$DEST/$2.part")" -ge "$3" ] || { echo "truncated: $2" >&2; exit 1; }
  mv "$DEST/$2.part" "$DEST/$2"
}

BASE="https://github.com/notofonts/noto-cjk/raw/main"
fetch "$BASE/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-SemiBold.otf" NotoSerifCJKsc-SemiBold.otf 20000000
fetch "$BASE/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf" NotoSansCJKsc-Regular.otf 14000000
echo "fonts ready in $DEST"

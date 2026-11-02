#!/usr/bin/env bash
# 生成 GitHub Releases 自动更新产物（安装包 + 签名 + update.json）。
# 用法：先完成带签名的构建
#   TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/tauri.key)" \
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
#   npm run tauri build -- --features heic
# 然后运行： ./finalize_update_channel.sh
# 产物在 release-v<version>/，随后创建 GitHub Release 并上传其中全部文件。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="shuci2007-glitch/stellar-memories"
# 版本号唯一来源：tauri.conf.json（避免脚本与配置不一致，1.2.0 的旧坑）
APP_VERSION="$(python3 -c "import json,sys;print(json.load(open('$ROOT/src-tauri/tauri.conf.json',encoding='utf-8'))['version'])")"
NSIS_DIR="$ROOT/src-tauri/target/release/bundle/nsis"
OUT_DIR="$ROOT/release-v$APP_VERSION"
# 安装包用 ASCII 名，GitHub 下载 URL 不需要百分号编码，跨工具更稳
SETUP_NAME="StellarMemories_${APP_VERSION}_x64-setup.exe"

echo "=== v$APP_VERSION ==="
INSTALLER="$(find "$NSIS_DIR" -maxdepth 1 -iname "*_${APP_VERSION}_x64-setup.exe" | head -1)"
if [ -z "$INSTALLER" ]; then
  echo "ERROR: $NSIS_DIR 里找不到 ${APP_VERSION} 的安装包，请先完成 tauri build" >&2
  exit 1
fi
echo "installer: $INSTALLER"

SIG="$INSTALLER.sig"
if [ ! -f "$SIG" ]; then
  echo "ERROR: 缺少签名文件 $SIG（构建时未设置 TAURI_SIGNING_PRIVATE_KEY）" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$INSTALLER" "$OUT_DIR/$SETUP_NAME"
cp "$SIG"       "$OUT_DIR/$SETUP_NAME.sig"

SIGNATURE="$(cat "$SIG")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
URL="https://github.com/$REPO/releases/download/v${APP_VERSION}/${SETUP_NAME}"

cat > "$OUT_DIR/update.json" <<EOF
{
  "version": "$APP_VERSION",
  "notes": "星辰相册 $APP_VERSION：转为纯本地版（移除云端相册）；新增时间轴批量整理与筛选、往年今天、全屏幻灯片放映、地图行程连播；安全与稳定性加固。",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "windows-x86_64": {
      "signature": "$SIGNATURE",
      "url": "$URL"
    }
  }
}
EOF

echo "=== 产物 ==="
ls -lh "$OUT_DIR"
echo
cat "$OUT_DIR/update.json"
echo
cat <<TIP
下一步（三件事，缺一不可）：
1. git tag -a v$APP_VERSION -m "v$APP_VERSION" && git push shuci v$APP_VERSION
2. 在 GitHub 建 Release（tag 选 v$APP_VERSION，不要勾 draft/prerelease），
   上传 release-v$APP_VERSION/ 下的三个文件：
     $SETUP_NAME
     $SETUP_NAME.sig
     update.json
3. 确认 https://github.com/$REPO/releases/latest/download/update.json 返回 $APP_VERSION
TIP

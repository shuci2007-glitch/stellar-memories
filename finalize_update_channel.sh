#!/usr/bin/env bash
# Finalize the auto-update channel after a signed `tauri build --features heic`.
# Run from the stellar-memories project root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NSIS_DIR="$ROOT/src-tauri/target/release/bundle/nsis"
WEB_UPDATE_DIR="$ROOT/../stellar-memories-web/update"
APP_VERSION="1.2.0"
SETUP_NAME="stellar-memories-setup.exe"

echo "=== locating built NSIS installer (version $APP_VERSION) ==="
# Tauri names the installer like <ProductName>_<version>_x64-setup.exe (Chinese name may keep CJK)
INSTALLER="$(find "$NSIS_DIR" -maxdepth 1 -iname "*_${APP_VERSION}_x64-setup.exe" | head -1)"
if [ -z "$INSTALLER" ]; then
  echo "ERROR: no installer found in $NSIS_DIR" >&2
  exit 1
fi
echo "found installer: $INSTALLER"

SIG="$INSTALLER.sig"
if [ ! -f "$SIG" ]; then
  echo "ERROR: signature file missing ($SIG). Did you set TAURI_SIGNING_PRIVATE_KEY?" >&2
  exit 1
fi

mkdir -p "$WEB_UPDATE_DIR"

# Copy installer under a stable ASCII name + its signature.
cp "$INSTALLER" "$WEB_UPDATE_DIR/$SETUP_NAME"
cp "$SIG"       "$WEB_UPDATE_DIR/$SETUP_NAME.sig"
echo "copied -> $WEB_UPDATE_DIR/$SETUP_NAME (+.sig)"

# Read signature (base64) for the manifest.
SIGNATURE="$(cat "$WEB_UPDATE_DIR/$SETUP_NAME.sig")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$WEB_UPDATE_DIR/update.json" <<EOF
{
  "version": "$APP_VERSION",
  "notes": "星辰相册 v$APP_VERSION：桌面端接入云端相册——用手机号登录后可直接浏览云端相册与照片，也能把本地照片上传到云端；同时改进了登录方式（密码 / 验证码）与手机端布局。",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "windows.x86_64": {
      "url": "https://stellar-memories.app.workbuddy.host/update/$SETUP_NAME?sharecode=7XVCZA6HXZ",
      "signature": "$SIGNATURE"
    }
  }
}
EOF

echo "=== wrote update.json ==="
cat "$WEB_UPDATE_DIR/update.json"
echo
echo "DONE. Next: deploy stellar-memories-web via workbuddy_sites_deploy so the URL is live."

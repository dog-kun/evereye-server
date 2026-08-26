#!/bin/sh
# 拉取 evereasy-download 公开发布仓的最新 APK 到本地分发目录。
# 由 docker-compose 的 release-sync 服务每 10 分钟调用一次。
# 仓库是公开的：无需任何 Token（如转私有，在 .env 配 GH_RELEASE_TOKEN 即可）。

set -u

REPO="${GH_REPO:-dog-kun/evereasy-download}"
OUT="${OUT_DIR:-/out}"
PUBLIC_BASE="${PUBLIC_BASE:-http://202.189.23.245:8787}"

AUTH=""
[ -n "${GH_RELEASE_TOKEN:-}" ] && AUTH="-H \"Authorization: Bearer ${GH_RELEASE_TOKEN}\""

[ -f "$OUT/.tag" ] || : > "$OUT/.tag"

json=$(curl -sf -m 20 -H "Accept: application/vnd.github+json" $AUTH \
  "https://api.github.com/repos/$REPO/releases/latest") || { echo "[sync] release API 不可达"; exit 0; }

tag=$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*: *"//;s/"$//')
[ -n "$tag" ] || { echo "[sync] 未解析到 tag"; exit 0; }

if [ "$tag" = "$(cat "$OUT/.tag")" ]; then
  echo "[sync] 已是最新 $tag"
  exit 0
fi

url=$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*\.apk"' | head -n1 | sed 's/.*: *"//;s/"$//')
[ -n "$url" ] || { echo "[sync] release $tag 无 APK 资产"; exit 0; }

echo "[sync] 拉取 $tag ← $url"
curl -sfL -m 300 $AUTH -o "$OUT/app-release.apk.tmp" "$url" \
  || { echo "[sync] 下载失败"; rm -f "$OUT/app-release.apk.tmp"; exit 0; }

mv "$OUT/app-release.apk.tmp" "$OUT/app-release.apk"
printf '{"version":"%s","builtAt":"%s","url":"%s/api/download/latest.apk"}\n' \
  "$tag" "$(date -u +%FT%TZ)" "$PUBLIC_BASE" > "$OUT/app-update.json"
echo "$tag" > "$OUT/.tag"
echo "[sync] ✓ 已就位 $tag"

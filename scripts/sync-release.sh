#!/bin/sh
# 拉取 dog-kun/evereasy 最新 Release 的 APK 到本地分发目录。
# 由 docker-compose 的 release-sync 服务每 10 分钟调用一次；
# 只需要一枚「只读」GitHub Token（.env 里 GH_RELEASE_TOKEN），服务器不做任何对外暴露。

set -u

REPO="${GH_REPO:-dog-kun/evereasy}"
OUT="${OUT_DIR:-/out}"
PUBLIC_BASE="${PUBLIC_BASE:-http://202.189.23.245:8787}"

[ -f "$OUT/.tag" ] || : > "$OUT/.tag"

json=$(curl -sf -m 20 \
  -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
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
curl -sfL -m 300 -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" -o "$OUT/app-release.apk.tmp" "$url" \
  || { echo "[sync] 下载失败"; rm -f "$OUT/app-release.apk.tmp"; exit 0; }

mv "$OUT/app-release.apk.tmp" "$OUT/app-release.apk"
printf '{"version":"%s","builtAt":"%s","url":"%s/api/download/latest.apk"}\n' \
  "$tag" "$(date -u +%FT%TZ)" "$PUBLIC_BASE" > "$OUT/app-update.json"
echo "$tag" > "$OUT/.tag"
echo "[sync] ✓ 已就位 $tag"

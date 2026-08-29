#!/bin/sh
# 拉取 evereasy-download 公开发布仓的最新 APK 到本地分发目录。
# 由 docker-compose 的 release-sync 服务每 10 分钟调用一次。
# 无需任何 Token；GitHub 直连不通时自动走 ghproxy 加速镜像。

set -u

REPO="${GH_REPO:-dog-kun/evereasy-download}"
OUT="${OUT_DIR:-/out}"
PUBLIC_BASE="${PUBLIC_BASE:-http://202.189.23.245:42363}"

[ -f "$OUT/.tag" ] || : > "$OUT/.tag"

# ── 解析最新 tag：利用 releases/latest 的 302 重定向，不依赖 GitHub API ──
tag=""
for base in "https://github.com" "https://ghproxy.net/https://github.com"; do
  loc=$(curl -sf -m 20 -o /dev/null -w '%{redirect_url}' "$base/$REPO/releases/latest") || continue
  tag=$(printf '%s' "$loc" | sed 's#.*/tag/##')
  [ -n "$tag" ] && break
done
[ -n "$tag" ] || { echo "[sync] 无法获取最新版本号(网络不可达?)"; exit 0; }

if [ "$tag" = "$(cat "$OUT/.tag")" ]; then
  exit 0
fi

asset="app-release.apk"
got=""
for base in "https://github.com" "https://ghproxy.net/https://github.com"; do
  echo "[sync] 尝试 $base ... ($tag)"
  curl -sfL -m 300 -o "$OUT/app-release.apk.tmp" \
    "$base/$REPO/releases/download/$tag/$asset" || continue
  # 校验是 zip(APK) 而不是错误页
  head -c2 "$OUT/app-release.apk.tmp" | grep -q "PK" && { got="$base"; break; }
done

if [ -z "$got" ]; then
  echo "[sync] 所有下载源均失败"
  rm -f "$OUT/app-release.apk.tmp"
  exit 0
fi

mv "$OUT/app-release.apk.tmp" "$OUT/app-release.apk"
# 合并写清单：只改安卓那几个字段，保住 desktop* 与 notes。
# 桌面安装包由 CI 直接 POST /api/admin/publish-desktop 推送，与本脚本互不相识；
# 整体覆盖会把 desktopUrl 抹掉，桌面端就再也收不到更新了。
mf="$OUT/app-update.json"
now="$(date -u +%FT%TZ)"
apk_url="$PUBLIC_BASE/api/download/latest.apk"
if [ -s "$mf" ]; then
  # 无 jq 可用（alpine 只装了 curl），用 sed 逐字段就地替换；字段缺失则追加
  tmp="$mf.tmp"
  cp "$mf" "$tmp"
  for pair in "version:$tag" "builtAt:$now" "url:$apk_url"; do
    k="${pair%%:*}"; v="${pair#*:}"
    if grep -q "\"$k\"[[:space:]]*:" "$tmp"; then
      # 分隔符用 | ：URL 里有 / 会撞掉 sed 的默认分隔符
      sed -i "s|\"$k\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"$k\": \"$v\"|" "$tmp"
    else
      sed -i "0,/{/s|{|{\n  \"$k\": \"$v\",|" "$tmp"
    fi
  done
  mv "$tmp" "$mf"
else
  printf '{\n  "version": "%s",\n  "builtAt": "%s",\n  "url": "%s"\n}\n' \
    "$tag" "$now" "$apk_url" > "$mf"
fi
echo "$tag" > "$OUT/.tag"
echo "[sync] ✓ 已就位 $tag (via $got)"

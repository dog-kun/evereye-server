#!/usr/bin/env bash
# 恒易记账后端 · 一键更新部署
#
# 用法(在服务器的 evereye-server 仓库目录里):
#   ./deploy.sh
#
# 做四件事:拉最新代码(GitHub 不通自动走 ghproxy 镜像) → 构建重启容器 → 健康检查 → 清理旧镜像。
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/4] 拉取最新代码..."
ORIGIN_URL=$(git remote get-url origin)
if ! git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
  MIRROR_URL="https://ghproxy.net/$ORIGIN_URL"
  echo "    GitHub 直连不通，改走镜像: $MIRROR_URL"
  git remote set-url origin "$MIRROR_URL"
fi
if ! git pull --ff-only; then
  # 镜像也失败或远端已切换过：还原原始地址再试一次，避免镜像地址被写死
  git remote set-url origin "$ORIGIN_URL"
  git pull --ff-only
fi

echo "[2/4] 构建镜像并重启容器(首次或改了 Dockerfile 会较慢)..."
docker compose up -d --build

echo "[3/4] 健康检查..."
for i in $(seq 1 10); do
  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT:-8787}/" >/dev/null 2>&1; then
    echo "✅ 部署成功:服务健康 (http://127.0.0.1:${PORT:-8787}/)"
    echo "    分发目录状态: cat /srv/evereasy-download/app-update.json 2>/dev/null || 尚未同步到安装包"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
done

echo "❌ 健康检查未通过,查看日志定位:"
echo "   docker compose logs -f"
exit 1

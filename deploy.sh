#!/usr/bin/env bash
# 恒易记账后端 · 一键更新部署
#
# 用法(在服务器的 evereye-server 仓库目录里):
#   ./deploy.sh
#
# 做四件事:拉最新代码 → 构建镜像并重启容器 → 健康检查 → 清理旧镜像。
# 首次部署前请先在 docker-compose.yml 里填好 OPENROUTER_API_KEY。
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/4] 拉取最新代码..."
git pull --ff-only

echo "[2/4] 构建镜像并重启容器(首次或改了 Dockerfile 会较慢)..."
docker compose up -d --build

echo "[3/4] 健康检查..."
for i in $(seq 1 10); do
  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT:-8787}/" >/dev/null 2>&1; then
    echo "✅ 部署成功:服务健康 (http://127.0.0.1:${PORT:-8787}/)"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
done

echo "❌ 健康检查未通过,查看日志定位:"
echo "   docker compose logs -f"
exit 1

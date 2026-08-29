#!/usr/bin/env bash
# EverEasy 后端诊断 + 免费模型可用性验证脚本
# 用途：①确认服务器当前状态 ②验证 CI/后端路径是否对齐 ③直接打智谱上游确认 glm-4-flash 免费模型可用
# 用法：bash verify-backend.sh
set -uo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[0;33m'; NC='\033[0m'
ok(){ printf "${GREEN}[OK]${NC}  %s\n" "$1"; }
bad(){ printf "${RED}[FAIL]${NC} %s\n" "$1"; }
warn(){ printf "${YEL}[WARN]${NC} %s\n" "$1"; }
sec(){ printf "\n=== %s ===\n" "$1"; }

sec "1. 容器与分发目录状态"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | grep -E 'evereasy|NAME' || true
echo "--- /srv/evereasy-download ---"
ls -la /srv/evereasy-download/ 2>&1 | sed 's/^/  /'
echo "--- app-update.json ---"
cat /srv/evereasy-download/app-update.json 2>&1 | sed 's/^/  /'

sec "2. 容器内关键环境变量"
docker exec evereasy-server env 2>/dev/null | grep -iE 'PUBLISH_TOKEN|GLM_API_KEY|OPENROUTER_API_KEY|PUBLIC_BASE' | \
  sed -E 's/(PUBLISH_TOKEN|GLM_API_KEY|OPENROUTER_API_KEY)=(.{4}).*/\1=\2***REDACTED***/' | sed 's/^/  /'

sec "3. 路由接线验证（本地回环 127.0.0.1:8787）"
TOKEN=$(docker exec evereasy-server env 2>/dev/null | grep '^PUBLISH_TOKEN=' | cut -d= -f2-)
echo "  PUBLISH_TOKEN 长度: ${#TOKEN}"
# 3a 正确路径（带 /api）应 200（无 body 会被 json 解析容错吞掉，但路由命中）
CODE_API=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST "http://127.0.0.1:8787/api/admin/publish-notes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"notes":"__diag__"}' 2>/dev/null)
echo "  POST /api/admin/publish-notes (正确路径) -> HTTP $CODE_API"
# 3b 错误路径（裸 /admin，CI 旧写法）应 404
CODE_BARE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST "http://127.0.0.1:8787/admin/publish-notes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"notes":"__diag__"}' 2>/dev/null)
echo "  POST /admin/publish-notes (CI旧路径)    -> HTTP $CODE_BARE"
# 3c AI 路由接线：无 token 应 401（证明路由存在且鉴权生效）
CODE_AI=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST "http://127.0.0.1:8787/api/ai/chat" \
  -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
echo "  POST /api/ai/chat (无token)             -> HTTP $CODE_AI (期望 401=路由已挂载)"
# 3d 下载直链（带 /api）
CODE_DL=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -I "http://127.0.0.1:8787/api/download/latest.apk" 2>/dev/null)
echo "  HEAD /api/download/latest.apk           -> HTTP $CODE_DL"

if [ "$CODE_API" = "200" ] || [ "$CODE_API" = "400" ]; then ok "CI新路径 /api/admin 可命中"; else bad "CI新路径异常 ($CODE_API)"; fi
if [ "$CODE_BARE" = "404" ]; then ok "CI旧路径 /admin 确实 404（印证根因）"; else warn "CI旧路径返回 $CODE_BARE（非预期404）"; fi
if [ "$CODE_AI" = "401" ]; then ok "/api/ai/chat 路由已挂载且鉴权生效"; else warn "/api/ai/chat 返回 $CODE_AI"; fi

sec "4. 免费模型可用性（直接打智谱上游，绕过登录）"
GLM_KEY=$(docker exec evereasy-server env 2>/dev/null | grep '^GLM_API_KEY=' | cut -d= -f2-)
GLM_BASE="${GLM_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"
GLM_MODEL="${GLM_MODEL:-glm-4-flash}"
echo "  上游: $GLM_BASE  模型: $GLM_MODEL  key长度: ${#GLM_KEY}"
RESP=$(curl -s --max-time 30 -X POST "$GLM_BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GLM_KEY" \
  -d '{"model":"'"$GLM_MODEL"'","messages":[{"role":"user","content":"用中文回答：1+1等于几？只答数字"}],"temperature":0.1,"stream":false}' 2>/dev/null)
echo "  上游响应: $RESP" | head -c 600
# 提取内容
CONTENT=$(printf '%s' "$RESP" | grep -oE '"content"[ ]*:[ ]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
if [ -n "$CONTENT" ]; then ok "免费模型 glm-4-flash 可用，模型返回: $CONTENT"; else bad "未从上游取到有效 content（key失效/模型不可用/额度耗尽？）"; fi

sec "5. CI 路径与后端挂载一致性（静态 grep）"
echo "  --- evereasy 仓库 CI 推送路径 ---"
grep -nE 'PUBLISH_URL/(api/)?admin/' /opt/evereye-server/../evereasy/.github/workflows/build-apk.yml 2>/dev/null || \
  echo "  (本地 evereasy 仓库不在标准位置，跳过；以服务器部署后 CI 实际跑为准)"
echo "  --- 后端 index.ts 挂载前缀 ---"
grep -nE "app.route\('/api'" /opt/evereye-server/src/index.ts 2>/dev/null | sed 's/^/  /'

sec "完成"

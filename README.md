# 恒易记账 · 同步后端 (evereasy-server)

极简云同步后端：**账号 + 端到端加密云备份 + 每 5 分钟自动同步 + 跨设备 + 扫码登录 + AI 全代理**。
技术栈 Node + Hono + SQLite（单文件数据库）。

> 本仓库为**私密仓库**，与主应用仓库（dog-kun/evereasy）分离：后端源码与部署配置不对公开可见。

> 设计原则：**可弃、零锁定**。服务器停了，App 依旧是纯本地记账器，功能一分不少。
> 所有数据存在一个 `data/evereasy.db` 文件里——想迁移/弃用，直接拷走这个文件。

---

## 〇、日常更新（一条命令）

代码推到本仓库 main 分支后，在**服务器的仓库目录**里执行：

```bash
./deploy.sh
```

脚本自动完成：`git pull` → `docker compose up -d --build` → 健康检查 → 清理旧镜像。
看到 `✅ 部署成功` 即完成。

### 首次部署到一台新服务器（一次性）

```bash
# 1. 克隆本仓库(私密仓库需授权:推荐用 GitHub fine-grained token 或部署密钥)
git clone https://github.com/dog-kun/evereye-server.git
cd evereye-server

# 2. 在 docker-compose.yml 里填好 GLM_API_KEY（或旧名 OPENROUTER_API_KEY 仍兼容）

# 3. 启动(此后每次更新只需 ./deploy.sh)
./deploy.sh
```

---

## 一、手动部署（不用脚本时）

服务器上装好 Docker + docker compose，然后：

```bash
cd server
docker compose up -d --build
```

启动后监听 `0.0.0.0:8787`。用 `http://你的服务器IP:8787` 访问。
健康检查：浏览器打开 `http://你的服务器IP:8787/` 应返回 `{"ok":true,...}`。

### 常用命令
```bash
docker compose logs -f          # 看日志
docker compose restart          # 重启
docker compose down             # 停止（数据仍在 ./data）
```

### 换端口
改 `docker-compose.yml` 里 `ports` 的宿主机侧，比如 `"9000:8787"`，然后 `docker compose up -d`。

### 数据备份/迁移
整个 `data/` 目录就是全部数据。定期拷贝即可；迁移服务器把它拷到新机器同位置再起容器。

---

## 二、安全模型（无 HTTPS 也尽量安全）

- **密码永不上传**。客户端用「密码 + encSalt」在本地派生**数据加密 key**（加解密备份），
  用「密码 + authSalt」派生**登录验证 key** 上传。两把 key 用不同盐，互相推不出。
- 服务器只存：登录验证 key 的 **scrypt 二次哈希**（拖库也登不了别处）、**加密盐**、**端到端加密后的密文**（看不懂内容）。
- **已知取舍**：无 HTTPS 时，登录验证 key 可能被同网中间人抓包重放（能冒充登录，但**解不开你的数据**，因为数据 key 从不上传）。
  以后加了域名 + HTTPS（如 Caddy 自动证书 / Cloudflare Tunnel）即可消除该风险，后端代码无需改动。

---

## 三、API 一览

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET  | `/` | 健康检查 | 否 |
| GET  | `/api/salt?email=` | 取该邮箱的 authSalt/encSalt（防枚举返回伪盐） | 否 |
| POST | `/api/register` | 注册 `{email, authKey, encSalt, deviceName?}` → `{token, encSalt}` | 否 |
| POST | `/api/login` | 登录 `{email, authKey, deviceName?}` → `{token, encSalt}` | 否 |
| GET  | `/api/me` | 校验 token，返回账号信息 | Bearer |
| POST | `/api/logout` | 退出本设备 | Bearer |
| PUT  | `/api/backup` | 上传密文 `{cipher, version}`（version 旧于服务器则 409） | Bearer |
| GET  | `/api/backup` | 下载密文 `{cipher, version, updatedAt}` | Bearer |
| POST | `/api/pair/start` | 电脑端发起配对，生成 `{code, expiresAt}`（5 分钟有效） | 否 |
| GET  | `/api/pair/poll?code=` | 电脑端轮询 `{status: pending/approved/expired, token?, encSalt?}` | 否 |
| POST | `/api/pair/scan` | 手机端扫码 `{code}`：grant 码免登录直接领取 token；request 码需已登录批准电脑 | 视码类型 |
| GET  | `/api/ai/channels` | 查询 AI 代理可用通道与默认模型 | Bearer |
| POST | `/api/ai/chat` | AI 对话全代理 `{messages, temperature?}`（非流式，见「AI 官方通道」） | Bearer |

**登录令牌长期有效**（按需求"不搞过一段时间退登录"），仅在用户主动 `/api/logout` 时失效。

### 扫码登录流程（固定方向：手机扫电脑）
1. **电脑端**（未登录）调 `/api/pair/start` 拿到 `code`，编成二维码显示，轮询 `/api/pair/poll`
2. **手机端**扫码得到 `code`，调 `/api/pair/scan`：request 码需已登录、批准电脑；grant 码免登录直接领取 token
3. 电脑端轮询到 `approved` → 拿到 token 完成登录
   —— 身份/密码始终在已登录的手机侧，电脑只是被授权的新设备。

---

## 四、AI 官方通道（后端全代理，App 端零配置 + 单模型硬锁）

App 内置官方 AI，经本服务器全代理转发到智谱 GLM：API Key 只配在服务器环境变量里，
永不随客户端分发；客户端只需登录即可使用。

**单模型硬锁**：服务器只允许调用 `GLM_MODEL`（默认 `glm-4-flash`）这一个模型。
请求体里的 `provider`/`model` 字段一律被忽略，不存在切换其他模型的入口——
即使有人直接调 API 也刷不了你这把 Key 下的其他模型配额。

| 环境变量 | 必填 | 默认 | 说明 |
|---------|------|------|------|
| `GLM_API_KEY` | ✅ AI 功能总开关 | — | 在 [open.bigmodel.cn](https://open.bigmodel.cn) 申请智谱 Key；仅用于调用上方固定模型。不填则 App 内提示「服务器未配置」。兼容回退：未设时回落读旧名 `OPENROUTER_API_KEY` |
| `GLM_BASE_URL` | 否 | `https://open.bigmodel.cn/api/paas/v4` | 上游地址（OpenAI 协议兼容）。兼容回退 `OPENROUTER_BASE_URL` |
| `GLM_MODEL` | 否 | `glm-4-flash` | 唯一允许调用的模型名。兼容回退 `OXALPHA_MODEL` |

行为细节：`POST /api/ai/chat` 强制非流式、90 秒上游超时（504）、请求体限 200KB（413）、
messages 形状严格校验（400）；上游错误原样透传状态码与 JSON。

---

## 五、本地开发（不用 Docker 时）

```bash
cd server
npm install
npm run dev      # tsx watch，改动自动重启
```

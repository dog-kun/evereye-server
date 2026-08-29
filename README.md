# 恒易记账 · 同步后端 (evereasy-server)

极简云同步后端：**账号 + 端到端加密云备份 + 每 5 分钟自动同步 + 跨设备 + 扫码登录 + AI 全代理 + 双端安装包分发 + 管理后台**。
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
| GET  | `/api/app-update` | 更新清单（两端字段共存，见「双端分发」） | 否 |
| GET  | `/api/download/latest.apk` | 最新安卓安装包（流式） | 否 |
| GET  | `/api/download/latest.exe` | 最新 Windows 安装包（流式） | 否 |
| POST | `/api/admin/publish-apk` | CI 推送安卓包（流式落盘，合并写清单） | `PUBLISH_TOKEN` |
| POST | `/api/admin/publish-desktop` | CI 推送 Windows 包（流式落盘，合并写清单） | `PUBLISH_TOKEN` |
| POST | `/api/admin/publish-notes` | CI 推送更新说明（两端共用） | `PUBLISH_TOKEN` |
| GET  | `/console` | 管理后台页面（单文件内联，见「管理后台」） | 页面内登录 |
| —    | `/api/console/*` | 管理后台接口（口令登录，票据 12 小时） | 管理票据 |

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

## 五、双端分发（安卓 APK + Windows exe）

两端的安装包都由 GitHub Actions 构建后推到本服务器，App 内「检查更新」直接读本服务器（国内直连最快）。

| | 安卓 | 桌面（Windows） |
| --- | --- | --- |
| CI workflow | `build-apk.yml`（ubuntu） | `build-desktop.yml`（windows） |
| 推送端点 | `POST /api/admin/publish-apk` | `POST /api/admin/publish-desktop` |
| 落盘文件 | `app-release.apk` | `evereasy-setup.exe` |
| 下载直链 | `GET /api/download/latest.apk` | `GET /api/download/latest.exe` |
| 清单字段 | `version` / `url` / `builtAt` | `desktopVersion` / `desktopUrl` / `desktopBuiltAt` |

### 一份清单，两端字段共存

`app-update.json` 同时保存两端的版本与直链，`notes` 共用：

```json
{
  "version": "v1.0.28",
  "url": "http://IP:PORT/api/download/latest.apk",
  "builtAt": "2026-08-29T10:47:26.203Z",
  "desktopVersion": "v1.0.28",
  "desktopUrl": "http://IP:PORT/api/download/latest.exe",
  "desktopBuiltAt": "2026-08-29T10:47:09.550Z",
  "notes": "更新说明"
}
```

三个 publish 端点都走**读-改-写合并**，只覆盖自己那几个字段。这是必须的：两条 CI 流水线独立运行、互不相识，若整体覆盖清单，后完成的那条会把先完成的字段抹掉（桌面先推、安卓后推 → `desktopUrl` 消失 → 桌面端再也收不到更新）。

App 端按平台取字段：安卓读 `version`/`url`，桌面读 `desktopVersion`/`desktopUrl`。**版本号必须跟着平台走**——两条流水线可能不同步（安卓已到 v1.0.29、桌面还在 v1.0.28），桌面若拿安卓的 `version` 去比版本，会把旧 exe 当新版反复提示下载。`desktopVersion` 缺失时回落 `version`，兼容旧清单。

### 上传是流式的

`saveBodyToFile` 用 `stream.pipeline` 把请求体直接写进 `.tmp` 再原子改名，全程不把整包读进内存。Windows 安装包接近 90 MB，而本机总内存 1 GB 且已被其他容器占去大半，`await c.req.arrayBuffer()` 那种一次性 Buffer 必然 OOM 杀进程。先 `.tmp` 后改名也保证传输中断时不会留下半截包被用户下载到。

### 桌面端的 GitHub 兜底

打 `v*` tag 时 CI 会把 exe 同时附到 GitHub Release。自有服务器不可达时，App 的 updater 会自动按 `.exe` 后缀从 Release 挑包（通道 1）。两条路径任一通，桌面端就能收到更新。

---

## 六、管理后台（`/console`）

站长控制台，浏览器打开 `http://你的服务器IP:端口/console`。

**默认关闭**——不配 `ADMIN_PASSWORD` 时页面显示「未启用」、所有 `/api/console/*` 返回 503。
不存在默认口令，也不存在"忘记口令找回"：口令就是环境变量本身。

### 开启

```bash
# 在服务器的 evereye-server 目录里（.env 已被 .gitignore 排除）
echo 'ADMIN_PASSWORD=换成你的强口令' >> .env
# 强烈建议同时限制来源 IP（逗号分隔多个）
echo 'ADMIN_ALLOW_IPS=你的家宽IP' >> .env
./deploy.sh
```

| 环境变量 | 必填 | 说明 |
|---------|------|------|
| `ADMIN_PASSWORD` | ✅ 后台总开关 | 管理口令。不填=后台整体关闭 |
| `ADMIN_ALLOW_IPS` | 否 | 来源 IP 白名单，逗号分隔；留空=不限制 |

> **先验证再启用白名单**：本部署在 NAT 之后，容器看到的源 IP 可能被网关改写。
> 实测从公网地址访问时，审计里记到的是 NAT 出口地址而非客户端真实 IP。
> 所以填 `ADMIN_ALLOW_IPS` 之前，请先从你打算使用的网络（手机/家宽）访问一次 `/console`
> 并故意输错一次口令，再在「审计」页看这条 `login-failed` 记录的 IP，用那个值填白名单。
> 直接猜一个 IP 填进去，很可能把自己锁在门外（此时只能改 `.env` 后重新部署解锁）。

### 能做什么

- **概览**：用户总数、近 7 天新增/活跃、登录设备数、云备份数与总体积、待用配对码、数据库文件体积、进程内存、运行时长、AI/CI 配置状态
- **用户**：按邮箱搜索分页；看每个账号的注册时间、设备数、最近活跃、备份版本与体积；踢单个设备下线、踢全部设备下线、删号（级联删备份与设备，需回填邮箱二次确认）
- **分发**：查看当前 `app-update.json` 与两端安装包（APK / Windows exe）的体积与时间；直接改「更新说明」（App 更新弹窗读它）
- **维护**：清理过期配对码与过期管理票据；`VACUUM` 收缩数据库
- **审计**：所有后台操作（含登录失败）留痕，带来源 IP

### 安全边界（务必知情）

- 与 App 用户体系**完全隔离**：口令来自环境变量、不进 `users` 表；App 的 Bearer token 在后台一律无效，管理票据也进不了 `/api/backup` 等业务接口。
- 管理票据 **12 小时过期**（后台是危险区，不学业务 token 的长期有效），存 `admin_sessions` 表，存在浏览器 `sessionStorage`（关标签即弃）。
- 登录失败按 IP 计数，**5 次锁 15 分钟**；锁定期内即使口令正确也拒绝。
- **端到端加密的底线不破**：后台能看到「密文有多大、什么时候更新的」，看不到账目内容——服务器没有数据密钥，有了后台也一样没有。
- **当前无 HTTPS**，口令与管理票据在公网明文传输，可能被同网中间人抓包。这是本部署的已知取舍：
  务必配 `ADMIN_ALLOW_IPS`，或干脆不开放端口、用 SSH 隧道访问
  （`ssh -L 8787:127.0.0.1:8787 root@服务器`，然后浏览器开 `http://127.0.0.1:8787/console`）。
- 页面带 CSP（`default-src 'none'`，禁一切外链）与 `X-Frame-Options: DENY`；无新依赖、无 CDN、无构建步骤。

---

## 七、本地开发（不用 Docker 时）

```bash
cd server
npm install
npm run dev      # tsx watch，改动自动重启
```

带后台跑：

```bash
ADMIN_PASSWORD=dev npm run dev   # 然后开 http://127.0.0.1:8787/console
```

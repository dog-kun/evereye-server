import { Hono } from 'hono';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs';
import { db } from './db.js';
import { adminPage } from './admin-page.js';

/**
 * 管理后台（挂载：页面 GET /console，接口 /api/console/*）
 *
 * 定位：给站长一个能看能管的控制台，而不是又一套用户系统。
 *   - 概览：用户数 / 备份体积 / 会话数 / 磁盘 / 运行时长
 *   - 用户：搜索、查看备份版本与体积、踢设备下线、删号（级联清备份）
 *   - 分发：看当前 app-update.json、改更新说明
 *   - 审计：所有危险操作留痕
 *
 * 与 App 用户体系**完全隔离**：口令来自环境变量 ADMIN_PASSWORD，不写进 users 表，
 * 管理票据存 admin_sessions（12 小时过期），App 的 Bearer token 在这里一律无效，
 * 反之管理票据也进不了 /api/backup 等业务接口。
 *
 * 端到端加密的底线不破：后台能看到「密文有多大、什么时候更新的」，
 * 但看不到账目内容——服务器没有数据 key，这一点不因为有了后台而改变。
 *
 * 安全边界（务必知情）：
 *   - ADMIN_PASSWORD 未设置 → 整个后台 503 关闭（默认关，不存在默认口令）
 *   - 登录失败按 IP 计数，5 次后锁 15 分钟
 *   - 当前部署无 HTTPS，口令与管理票据在公网明文传输，可能被同网中间人抓包。
 *     因此额外提供 ADMIN_ALLOW_IPS 白名单（逗号分隔，留空=不限制）；
 *     强烈建议只从固定 IP 访问，或用 SSH 隧道访问 127.0.0.1。
 */

const app = new Hono();

/** 管理票据有效期：12 小时（后台是危险区，不学业务 token 的长期有效） */
const TTL_MS = 12 * 60 * 60 * 1000;

/** 登录失败锁定：同 IP 连续 5 次失败锁 15 分钟 */
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/**
 * IP → 失败计数与锁定截止（内存态，重启即清；不为它引入依赖）。
 * lockedUntil=0 表示"计过失败但未锁"，与"锁已过期"是两种状态——
 * 早期版本把两者混为一谈，导致计数每次都被重置、永远锁不上。
 */
const failMap = new Map<string, { fails: number; lockedUntil: number }>();

/** 进程启动时刻，用于展示运行时长 */
const BOOT_AT = Date.now();

const now = (): string => new Date().toISOString();

/** 后台是否启用（未配置口令即整体关闭） */
function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD?.trim();
  return p ? p : null;
}

/** IP 白名单（留空=不限制） */
function allowedIps(): string[] {
  return (process.env.ADMIN_ALLOW_IPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 取客户端 IP。
 *
 * 优先 X-Forwarded-For 首段（经反代/NAT 转发时），否则回落到 Node 原始 socket 地址。
 * 必须有 socket 兜底：本部署是裸 Docker 端口映射、没有反代，
 * 若只认 XFF 会让所有请求都变成 unknown —— 一旦配了 ADMIN_ALLOW_IPS 就会把站长自己锁在门外。
 * IPv6 映射前缀（::ffff:1.2.3.4）统一剥掉，便于白名单里直接写 IPv4。
 *
 * 已知局限（实测确认）：本机在 NAT 之后，从公网访问时容器看到的是 NAT 出口地址，
 * 不是客户端真实 IP；Docker 内网访问则看到网关地址（如 192.168.x.1）。
 * 因此白名单的正确用法是「先看审计里记到的值，再填那个值」，见 README 第五节。
 */
function clientIp(c: {
  req: { header: (k: string) => string | undefined };
  env?: unknown;
}): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return normalizeIp(xff.split(',')[0].trim());
  const real = c.req.header('x-real-ip');
  if (real) return normalizeIp(real.trim());
  // @hono/node-server 把 Node 的 IncomingMessage 挂在 c.env.incoming
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const addr = incoming?.socket?.remoteAddress;
  return addr ? normalizeIp(addr) : 'unknown';
}

/** ::ffff:1.2.3.4 → 1.2.3.4；::1 → 127.0.0.1 */
function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

/** 恒定时间比较口令（长度不同也不早退，用 sha256 归一到等长） */
function samePassword(input: string, expected: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 写审计（失败不影响主流程） */
function audit(action: string, target: string | null, detail: string | null, ip: string): void {
  try {
    db.prepare(
      'INSERT INTO admin_audit (action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(action, target, detail, ip, now());
  } catch {
    // 审计表写不进也不能拖垮管理操作
  }
}

/** 校验管理票据，返回 token（无效返回 null）；顺带清理过期票据 */
function adminToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1];
  const row = db.prepare('SELECT token, expires_at FROM admin_sessions WHERE token = ?').get(token) as
    | { token: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return token;
}

/** 中间件：后台已启用 + IP 允许 + 票据有效 */
async function guard(c: any, next: any): Promise<Response | void> {
  if (!adminPassword()) return c.json({ error: '管理后台未启用（服务器未配置 ADMIN_PASSWORD）' }, 503);
  const list = allowedIps();
  if (list.length > 0 && !list.includes(clientIp(c))) {
    return c.json({ error: '来源 IP 不在白名单内' }, 403);
  }
  if (!adminToken(c.req.header('Authorization'))) {
    return c.json({ error: '未登录或登录已过期' }, 401);
  }
  await next();
}

// ─── 登录 / 登出 ────────────────────────────────────────────────

/** 后台是否可用（页面加载时先问一次，决定显示登录框还是"未启用"提示） */
app.get('/status', (c) => {
  const list = allowedIps();
  return c.json({
    enabled: adminPassword() !== null,
    ipRestricted: list.length > 0,
    ipAllowed: list.length === 0 || list.includes(clientIp(c)),
  });
});

app.post('/login', async (c) => {
  const expected = adminPassword();
  if (!expected) return c.json({ error: '管理后台未启用（服务器未配置 ADMIN_PASSWORD）' }, 503);

  const ip = clientIp(c);
  const list = allowedIps();
  if (list.length > 0 && !list.includes(ip)) {
    audit('login-blocked-ip', null, `ip=${ip}`, ip);
    return c.json({ error: '来源 IP 不在白名单内' }, 403);
  }

  const lock = failMap.get(ip);
  if (lock && lock.lockedUntil > Date.now()) {
    const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
    return c.json({ error: `失败次数过多，请 ${mins} 分钟后再试` }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const password = String(body?.password ?? '');
  if (!password || !samePassword(password, expected)) {
    // 只有"锁定过且锁已过期"才归零重新计数；lockedUntil=0（计过失败但未锁）必须累加
    const expiredLock = lock !== undefined && lock.lockedUntil > 0;
    const fails = (expiredLock ? 0 : lock?.fails ?? 0) + 1;
    const locked = fails >= MAX_FAILS;
    failMap.set(ip, { fails, lockedUntil: locked ? Date.now() + LOCK_MS : 0 });
    audit('login-failed', null, `fails=${fails}${locked ? ' 已锁定15分钟' : ''}`, ip);
    return c.json(
      locked
        ? { error: `失败次数过多，已锁定 ${LOCK_MS / 60000} 分钟` }
        : { error: `口令错误（还可尝试 ${MAX_FAILS - fails} 次）` },
      locked ? 429 : 401,
    );
  }

  failMap.delete(ip);
  const token = randomBytes(32).toString('hex');
  const created = new Date();
  db.prepare('INSERT INTO admin_sessions (token, ip, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    ip,
    created.toISOString(),
    new Date(created.getTime() + TTL_MS).toISOString(),
  );
  audit('login', null, null, ip);
  return c.json({ token, expiresIn: TTL_MS });
});

app.post('/logout', guard, (c) => {
  const t = adminToken(c.req.header('Authorization'));
  if (t) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(t);
  return c.json({ ok: true });
});

// ─── 概览 ──────────────────────────────────────────────────────

app.get('/overview', guard, (c) => {
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;

  const users = one<{ n: number }>('SELECT COUNT(*) AS n FROM users').n;
  const sessions = one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').n;
  const backups = one<{ n: number; bytes: number | null }>(
    'SELECT COUNT(*) AS n, SUM(LENGTH(cipher)) AS bytes FROM backups',
  );
  const pending = one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM pairings WHERE expires_at > ?',
    now(),
  ).n;

  // 近 7 天新增（created_at 是 ISO 串，字典序即时间序，可直接比较）
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const newUsers = one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', weekAgo).n;
  const activeWeek = one<{ n: number }>(
    'SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen >= ?',
    weekAgo,
  ).n;
  const syncWeek = one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM backups WHERE updated_at >= ?',
    weekAgo,
  ).n;

  // 数据库文件体积（含 WAL）
  const dbPath = process.env.EVEREASY_DB ?? 'data/evereasy.db';
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      dbBytes += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      // 文件不存在（WAL 已 checkpoint）
    }
  }

  const mem = process.memoryUsage();
  return c.json({
    users,
    newUsers7d: newUsers,
    activeUsers7d: activeWeek,
    sessions,
    backups: backups.n,
    backupBytes: backups.bytes ?? 0,
    syncedThisWeek: syncWeek,
    pendingPairings: pending,
    dbBytes,
    uptimeMs: Date.now() - BOOT_AT,
    rssBytes: mem.rss,
    nodeVersion: process.version,
    aiConfigured: Boolean(process.env.GLM_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim()),
    publishConfigured: Boolean(process.env.PUBLISH_TOKEN?.trim()),
    serverTime: now(),
  });
});

// ─── 用户 ──────────────────────────────────────────────────────

interface UserListRow {
  id: string;
  email: string;
  created_at: string;
  devices: number;
  last_seen: string | null;
  backup_version: number | null;
  backup_bytes: number | null;
  backup_at: string | null;
}

app.get('/users', guard, (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

  // LIKE 参数化传值，不拼字符串（防注入）
  const where = q ? 'WHERE LOWER(u.email) LIKE ?' : '';
  const args: unknown[] = q ? [`%${q}%`] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...args) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.created_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS devices,
              (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
              b.version AS backup_version,
              LENGTH(b.cipher) AS backup_bytes,
              b.updated_at AS backup_at
         FROM users u
         LEFT JOIN backups b ON b.user_id = u.id
         ${where}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as UserListRow[];

  return c.json({
    total,
    limit,
    offset,
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      devices: r.devices,
      lastSeen: r.last_seen,
      backupVersion: r.backup_version,
      backupBytes: r.backup_bytes,
      backupAt: r.backup_at,
    })),
  });
});

/** 某用户的登录设备列表（token 只回前 8 位，避免后台页面泄漏可用凭据） */
app.get('/users/:id/sessions', guard, (c) => {
  const id = c.req.param('id');
  const rows = db
    .prepare(
      'SELECT token, device_name, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC',
    )
    .all(id) as { token: string; device_name: string | null; created_at: string; last_seen: string }[];
  return c.json({
    sessions: rows.map((r) => ({
      tokenPrefix: r.token.slice(0, 8),
      deviceName: r.device_name,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
    })),
  });
});

/** 踢单个设备下线（按 token 前缀定位，避免前端持有完整凭据） */
app.delete('/users/:id/sessions/:prefix', guard, (c) => {
  const id = c.req.param('id');
  const prefix = c.req.param('prefix');
  if (!/^[a-f0-9]{8,}$/i.test(prefix)) return c.json({ error: 'token 前缀不合法' }, 400);
  const row = db
    .prepare('SELECT token FROM sessions WHERE user_id = ? AND token LIKE ?')
    .get(id, `${prefix}%`) as { token: string } | undefined;
  if (!row) return c.json({ error: '设备不存在' }, 404);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(row.token);
  audit('revoke-session', id, `prefix=${prefix}`, clientIp(c));
  return c.json({ ok: true });
});

/** 踢该用户全部设备下线 */
app.delete('/users/:id/sessions', guard, (c) => {
  const id = c.req.param('id');
  const info = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit('revoke-all-sessions', id, `count=${info.changes}`, clientIp(c));
  return c.json({ ok: true, revoked: info.changes });
});

/**
 * 删号（危险，不可逆）：级联删 sessions/backups（外键 ON DELETE CASCADE）。
 * 必须在 body 里回填该用户邮箱作为二次确认，防误点。
 */
app.delete('/users/:id', guard, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const confirmEmail = String(body?.confirmEmail ?? '').trim().toLowerCase();

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as
    | { id: string; email: string }
    | undefined;
  if (!user) return c.json({ error: '用户不存在' }, 404);
  if (confirmEmail !== user.email.toLowerCase()) {
    return c.json({ error: '确认邮箱不匹配，已取消' }, 400);
  }

  // 一个事务里删干净：外键级联负责 sessions/backups，pairings 无外键需手动清
  db.transaction(() => {
    db.prepare('DELETE FROM pairings WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  audit('delete-user', id, `email=${user.email}`, clientIp(c));
  return c.json({ ok: true });
});

// ─── 维护 ──────────────────────────────────────────────────────

/** 清理过期配对码 + 过期管理票据 */
app.post('/cleanup', guard, (c) => {
  const ts = now();
  const pair = db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(ts);
  const adm = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(ts);
  audit('cleanup', null, `pairings=${pair.changes} adminSessions=${adm.changes}`, clientIp(c));
  return c.json({ ok: true, pairings: pair.changes, adminSessions: adm.changes });
});

/** SQLite 收缩（VACUUM 会重写整个库文件，大库上耗时，前端已提示） */
app.post('/vacuum', guard, (c) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    audit('vacuum', null, null, clientIp(c));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: `收缩失败：${String(e)}` }, 500);
  }
});

// ─── 分发通道 ───────────────────────────────────────────────────

const downloadDir = (): string => process.env.EVEREASY_DOWNLOAD_DIR ?? '/app/data/download';

app.get('/delivery', guard, (c) => {
  const d = downloadDir();
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(fs.readFileSync(`${d}/app-update.json`, 'utf8'));
  } catch {
    manifest = null;
  }
  let apk: { bytes: number; mtime: string } | null = null;
  try {
    const st = fs.statSync(`${d}/app-release.apk`);
    apk = { bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    apk = null;
  }
  return c.json({ dir: d, manifest, apk });
});

/** 改更新说明（App 的更新弹窗读这个字段） */
app.post('/delivery/notes', guard, async (c) => {
  const body = await c.req.json().catch(() => null);
  const notes = body?.notes;
  if (typeof notes !== 'string') return c.json({ error: 'notes 必须是字符串' }, 400);
  if (notes.length > 4000) return c.json({ error: 'notes 过长（>4000 字）' }, 413);
  const path = `${downloadDir()}/app-update.json`;
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return c.json({ error: '暂无更新清单（等 CI 推送一次安装包后再改说明）' }, 404);
  }
  info.notes = notes;
  try {
    fs.writeFileSync(path, JSON.stringify(info, null, 2));
  } catch (e) {
    return c.json({ error: `写入失败：${String(e)}` }, 500);
  }
  audit('publish-notes', null, `len=${notes.length}`, clientIp(c));
  return c.json({ ok: true });
});

// ─── 审计 ──────────────────────────────────────────────────────

app.get('/audit', guard, (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const rows = db
    .prepare('SELECT action, target, detail, ip, created_at FROM admin_audit ORDER BY id DESC LIMIT ?')
    .all(limit) as { action: string; target: string | null; detail: string | null; ip: string | null; created_at: string }[];
  return c.json({
    entries: rows.map((r) => ({
      action: r.action,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      at: r.created_at,
    })),
  });
});

// ─── 页面 ──────────────────────────────────────────────────────

/**
 * 控制台页面的响应头。
 * 页面只加载自身内联脚本，禁一切外链，降低无 HTTPS 下被注入的风险。
 */
export const ADMIN_PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/** 控制台页面 HTML（单文件内联，无构建步骤 / 无 CDN / 无新依赖） */
export { adminPage };

export default app;

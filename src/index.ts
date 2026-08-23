import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { db } from './db.js';
import aiRoutes from './ai.js';
import {
  randomHex,
  newToken,
  hashAuthKey,
  safeEqualHex,
  authUserId,
} from './auth.js';

/**
 * 恒易记账 简易同步后端（Node + Hono + SQLite）
 *
 * 职责（刻意做小，几乎零维护；服务器停了 App 仍是纯本地记账器）：
 *   - 账号：邮箱 + 密码注册/登录（无验证码），端到端加密，密码不离开设备
 *   - 云备份：存/取端到端加密后的密文 blob，服务器看不懂内容；支持每 5 分钟自动上传
 *   - 跨设备：登录后各设备都能上传/下载同一份备份，按 version 判断新旧
 *   - 扫码登录：已登录设备生成配对码 → 新设备扫码即免密登录（双向：手机扫电脑 / 电脑扫手机）
 *   - AI 代理：/api/ai/* 转发 OpenRouter（OxAlpha 官方免费模型同源），API Key 只配在服务器
 *
 * 部署：Docker（无域名无 HTTPS，直接 http://IP:PORT 访问；见 README）。
 */

const app = new Hono();

// 允许任意来源（App 是本地/打包客户端，非同源）；不使用 Cookie，仅 Bearer token
app.use('/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }));

const now = (): string => new Date().toISOString();

// ─── 健康检查 ───
app.get('/', (c) => c.json({ ok: true, service: 'evereasy-server', time: now() }));

// ─── AI 官方通道 · 后端全代理（OpenRouter / OxAlpha，Key 配在服务器环境变量，App 端零配置）───
app.route('/api/ai', aiRoutes);

// ─── 行类型 ───
interface UserRow {
  id: string;
  email: string;
  auth_hash: string;
  auth_salt: string;
  enc_salt: string;
}
interface BackupRow {
  cipher: string;
  version: number;
  updated_at: string;
}
interface PairingRow {
  code: string;
  kind: string;
  user_id: string | null;
  token: string | null;
  enc_salt: string | null;
  approved: number;
  expires_at: string;
}

/**
 * 1) 获取某邮箱的加密盐（enc_salt）与登录盐（auth_salt）。
 * 客户端登录/注册前需先拿到盐，才能在本地派生 auth-key 与数据 key。
 * 邮箱不存在时返回一组「确定性伪盐」（由邮箱推导），避免暴露"该邮箱是否注册"。
 */
app.get('/api/salt', (c) => {
  const email = (c.req.query('email') ?? '').trim().toLowerCase();
  if (!email) return c.json({ error: '缺少 email' }, 400);
  const row = db
    .prepare('SELECT auth_salt, enc_salt FROM users WHERE email = ?')
    .get(email) as Pick<UserRow, 'auth_salt' | 'enc_salt'> | undefined;
  if (row) {
    return c.json({ authSalt: row.auth_salt, encSalt: row.enc_salt, exists: true });
  }
  // 伪盐：对同一邮箱稳定，但与真实注册无关，仅为防枚举
  const fake = hashAuthKey(email, 'evereasy-pseudo-salt');
  return c.json({
    authSalt: fake.slice(0, 32),
    encSalt: fake.slice(32, 64),
    exists: false,
  });
});

/**
 * 2) 注册：客户端提交 email + authKey（= 密码派生的登录验证 key）+ encSalt（客户端生成的加密盐）。
 * 服务器再用自己的 auth_salt 对 authKey 做 scrypt 二次哈希存储。
 */
app.post('/api/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const authKey = String(body?.authKey ?? '');
  const encSalt = String(body?.encSalt ?? '');
  if (!email || !authKey || !encSalt) return c.json({ error: '参数不完整' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: '邮箱格式不对' }, 400);

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return c.json({ error: '该邮箱已注册' }, 409);

  const id = randomHex(16);
  const authSalt = randomHex(16);
  const authHash = hashAuthKey(authKey, authSalt);
  db.prepare(
    'INSERT INTO users (id, email, auth_hash, auth_salt, enc_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, email, authHash, authSalt, encSalt, now());

  const token = issueToken(id, String(body?.deviceName ?? ''));
  return c.json({ token, encSalt });
});

/**
 * 3) 登录：客户端先 GET /api/salt 拿到 auth_salt，本地派生 authKey，再提交。
 */
app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const authKey = String(body?.authKey ?? '');
  if (!email || !authKey) return c.json({ error: '参数不完整' }, 400);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  if (!user) return c.json({ error: '邮箱或密码错误' }, 401);

  const candidate = hashAuthKey(authKey, user.auth_salt);
  if (!safeEqualHex(candidate, user.auth_hash)) {
    return c.json({ error: '邮箱或密码错误' }, 401);
  }
  const token = issueToken(user.id, String(body?.deviceName ?? ''));
  return c.json({ token, encSalt: user.enc_salt });
});

/** 4) 拉取当前用户信息（校验 token 是否有效） */
app.get('/api/me', (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '未登录' }, 401);
  const user = db.prepare('SELECT id, email, enc_salt FROM users WHERE id = ?').get(uid) as
    | Pick<UserRow, 'id' | 'email' | 'enc_salt'>
    | undefined;
  if (!user) return c.json({ error: '用户不存在' }, 404);
  return c.json({ id: user.id, email: user.email, encSalt: user.enc_salt });
});

/** 5) 退出登录（删除本设备 token） */
app.post('/api/logout', (c) => {
  const auth = c.req.header('Authorization');
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
  return c.json({ ok: true });
});

/**
 * 6) 上传备份（端到端加密后的密文）。客户端每 5 分钟或有变更时调用。
 * version 单调递增：服务器只在 version >= 现存 version 时接受，避免旧设备覆盖新数据。
 */
app.put('/api/backup', async (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '未登录' }, 401);
  const body = await c.req.json().catch(() => null);
  const cipher = String(body?.cipher ?? '');
  const version = Number(body?.version ?? 0);
  if (!cipher || !Number.isFinite(version)) return c.json({ error: '参数不完整' }, 400);
  // 体积上限：单用户一份密文 blob，正常远小于 10MB；超限视为异常客户端，拒收防写爆 SQLite
  if (cipher.length > 10_000_000) return c.json({ error: '备份过大（>10MB），拒绝接收' }, 413);

  const existing = db.prepare('SELECT version FROM backups WHERE user_id = ?').get(uid) as
    | Pick<BackupRow, 'version'>
    | undefined;
  if (existing && version < existing.version) {
    // 服务器已有更新的版本 → 拒绝，提示客户端先下载合并
    return c.json({ error: 'stale', serverVersion: existing.version }, 409);
  }

  db.prepare(
    `INSERT INTO backups (user_id, cipher, version, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET cipher = excluded.cipher, version = excluded.version, updated_at = excluded.updated_at`,
  ).run(uid, cipher, version, now());
  return c.json({ ok: true, version });
});

/** 7) 下载备份（返回密文 + 版本；客户端本地用密码派生 key 解密） */
app.get('/api/backup', (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '未登录' }, 401);
  const row = db
    .prepare('SELECT cipher, version, updated_at FROM backups WHERE user_id = ?')
    .get(uid) as BackupRow | undefined;
  if (!row) return c.json({ cipher: null, version: 0 });
  return c.json({ cipher: row.cipher, version: row.version, updatedAt: row.updated_at });
});

// ─── 扫码登录（固定方向：手机扫电脑）───
//
// ─── 扫码登录（电脑永远显示二维码，手机永远扫码，不分谁先登录）───
//
// 两种场景，方向都是「电脑出码 / 手机扫」：
//  A. 电脑未登录 + 手机已登录（kind=request）：
//     1. 电脑 /api/pair/start 生成 request 码 → 显示二维码 + 轮询 /api/pair/poll
//     2. 手机扫码 → /api/pair/approve 批准 → 服务器为电脑签发 token
//     3. 电脑轮询拿到 token 登录
//  B. 电脑已登录 + 手机未登录（kind=grant）：
//     1. 电脑（带 token）/api/pair/start → 生成 grant 码（token 已内置）→ 显示二维码
//     2. 手机扫码 → /api/pair/claim 直接领取 token 登录
//
// 电脑端不管自己登没登录，统一调 /api/pair/start（带不带 token 决定 kind），
// 都是显示一个二维码；手机端扫码后按码的 kind 自动走 approve 或 claim。

/**
 * 8) 电脑端发起配对，生成二维码用的 code。
 *    - 带有效 token（电脑已登录）→ kind=grant，token 内置，手机扫码即可登录
 *    - 无 token（电脑未登录）→ kind=request，等手机扫码批准
 */
app.post('/api/pair/start', (c) => {
  const code = randomHex(12);
  const created = new Date();
  const expires = new Date(created.getTime() + 5 * 60 * 1000);
  const uid = authUserId(c.req.header('Authorization'));
  if (uid) {
    // 电脑已登录：生成 grant 码，内置一枚新 token 供手机领取
    const user = db.prepare('SELECT enc_salt FROM users WHERE id = ?').get(uid) as
      | Pick<UserRow, 'enc_salt'>
      | undefined;
    const grantTok = issueToken(uid, '扫码登录设备');
    db.prepare(
      'INSERT INTO pairings (code, kind, user_id, token, enc_salt, approved, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(code, 'grant', uid, grantTok, user?.enc_salt ?? '', created.toISOString(), expires.toISOString());
    return c.json({ code, kind: 'grant', expiresAt: expires.toISOString() });
  }
  // 电脑未登录：生成 request 码，等手机批准
  db.prepare(
    'INSERT INTO pairings (code, kind, approved, created_at, expires_at) VALUES (?, ?, 0, ?, ?)',
  ).run(code, 'request', created.toISOString(), expires.toISOString());
  return c.json({ code, kind: 'request', expiresAt: expires.toISOString() });
});

/**
 * 9) 电脑端轮询（仅 request 场景需要）：手机批准后返回 token + encSalt。
 */
app.get('/api/pair/poll', (c) => {
  const code = c.req.query('code') ?? '';
  if (!code) return c.json({ error: '缺少 code' }, 400);
  const row = db.prepare('SELECT * FROM pairings WHERE code = ?').get(code) as
    | PairingRow
    | undefined;
  if (!row) return c.json({ error: '配对码无效' }, 404);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ status: 'expired' });
  }
  if (row.approved && row.token) {
    const token = row.token;
    const encSalt = row.enc_salt ?? '';
    db.prepare('DELETE FROM pairings WHERE code = ?').run(code);
    return c.json({ status: 'approved', token, encSalt });
  }
  return c.json({ status: 'pending' });
});

/**
 * 10) 手机端扫码后调用（自动判断码类型）：
 *     - request 码：需已登录，批准电脑登录（为电脑签发 token）
 *     - grant 码：无需登录，直接领取电脑发放的 token 完成手机登录
 */
app.post('/api/pair/scan', async (c) => {
  const body = await c.req.json().catch(() => null);
  const code = String(body?.code ?? '');
  if (!code) return c.json({ error: '缺少配对码' }, 400);
  const row = db.prepare('SELECT * FROM pairings WHERE code = ?').get(code) as
    | PairingRow
    | undefined;
  if (!row) return c.json({ error: '配对码无效' }, 404);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ error: '配对码已过期' }, 410);
  }

  if (row.kind === 'grant') {
    // 手机领取电脑发放的登录（无需手机先登录）
    if (row.approved === 0 || !row.token) return c.json({ error: '配对码无效' }, 409);
    const token = row.token;
    const encSalt = row.enc_salt ?? '';
    db.prepare('DELETE FROM pairings WHERE code = ?').run(code); // 一次性
    return c.json({ mode: 'login', token, encSalt });
  }

  // kind === 'request'：手机（已登录）批准电脑
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '请先在手机上登录，再扫码授权电脑' }, 401);
  if (row.approved) return c.json({ error: '该码已被批准' }, 409);
  const user = db.prepare('SELECT enc_salt FROM users WHERE id = ?').get(uid) as
    | Pick<UserRow, 'enc_salt'>
    | undefined;
  const newTok = issueToken(uid, '扫码登录设备');
  db.prepare(
    'UPDATE pairings SET approved = 1, user_id = ?, token = ?, enc_salt = ? WHERE code = ?',
  ).run(uid, newTok, user?.enc_salt ?? '', code);
  return c.json({ mode: 'approved' });
});

/**
 * 签发登录令牌并写入 sessions（长期有效，不主动过期——用户要求"不搞过一段时间退登录"）。
 */
function issueToken(userId: string, deviceName: string): string {
  const token = newToken();
  const ts = now();
  db.prepare(
    'INSERT INTO sessions (token, user_id, device_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
  ).run(token, userId, deviceName || null, ts, ts);
  return token;
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
console.log(`[evereasy-server] listening on http://0.0.0.0:${port}`);

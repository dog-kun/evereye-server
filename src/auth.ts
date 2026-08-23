import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

/**
 * 认证与安全工具
 *
 * 密码安全模型（端到端加密，无 HTTPS 也尽量安全）：
 *   1. 用户密码永不上传。客户端用 密码 + enc_salt 派生「数据加密 key」（本地加解密备份用）；
 *      再用 密码 + auth_salt 派生「登录验证 key」上传给服务器。两个 salt 不同 → 两个 key 无法互推。
 *   2. 服务器拿到「登录验证 key」后再用 scrypt + 自己的 auth_salt 二次哈希存库。
 *      故：抓包只能拿到验证 key（解不开数据）；拖库只能拿到二次哈希（登不了别处）。
 *   注：无 HTTPS 时验证 key 仍可能被中间人重放，属已知取舍；数据本身端到端加密不受影响。
 */

/** 生成随机 hex 串（默认 16 字节 = 32 hex 字符） */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** 生成登录令牌（32 字节，长期有效） */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** 用 scrypt 对客户端上传的 auth-key 二次哈希（服务器侧存储用） */
export function hashAuthKey(authKey: string, salt: string): string {
  return scryptSync(authKey, salt, 64).toString('hex');
}

/** 恒定时间比较，防时序攻击 */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 会话行 */
interface SessionRow {
  token: string;
  user_id: string;
}

/**
 * 校验请求头里的 Bearer token，返回 userId（无效返回 null）。
 * 校验通过时顺带刷新 last_seen。
 */
export function authUserId(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1];
  const row = db
    .prepare('SELECT token, user_id FROM sessions WHERE token = ?')
    .get(token) as SessionRow | undefined;
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(
    new Date().toISOString(),
    token,
  );
  return row.user_id;
}

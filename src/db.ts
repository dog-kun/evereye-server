import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 数据库（单文件，跑路成本最低——想弃用直接拷走 data/evereasy.db）
 *
 * 表设计（极简，只服务于"账号 + 端到端加密云备份 + 扫码登录"）：
 *   users    - 用户：邮箱 + 登录验证凭证（authVerifier，不是原始密码）+ 加密盐
 *   sessions - 登录令牌：token → userId，长期有效（用户要求"不搞过一段时间退登录"）
 *   backups  - 云备份：每用户一份，存端到端加密后的密文 blob（服务器看不懂内容）
 *   pairings - 扫码配对：一次性配对码，用于"已登录设备"授权"新设备"免密登录
 */

const DB_PATH = process.env.EVEREASY_DB ?? 'data/evereasy.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  -- 登录验证凭证：客户端用密码推导出的 auth-key，再由服务器 scrypt 二次哈希存储
  -- 原始密码永不离开设备，故即使 HTTP 抓包也拿不到密码、解不开数据
  auth_hash     TEXT NOT NULL,
  auth_salt     TEXT NOT NULL,
  -- 加密盐：客户端用它 + 密码派生数据加密 key（服务器只存储、不参与解密）
  enc_salt      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  device_name TEXT,
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backups (
  user_id    TEXT PRIMARY KEY,
  -- 端到端加密后的密文（base64），服务器无法解密
  cipher     TEXT NOT NULL,
  -- 客户端本地数据版本号（单调递增），用于跨设备冲突判断
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pairings (
  code       TEXT PRIMARY KEY,
  -- kind='request'：电脑未登录求授权（手机 approve 后填 token）
  -- kind='grant'  ：电脑已登录发放登录（建时即填好 token，手机 claim 领取）
  kind       TEXT NOT NULL,
  user_id    TEXT,
  token      TEXT,
  enc_salt   TEXT,
  approved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

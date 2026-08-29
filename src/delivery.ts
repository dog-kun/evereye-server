import fs from 'node:fs';
import { Hono } from 'hono';

/**
 * 自有分发通道（挂载于 /api，见 index.ts: app.route('/api', deliveryRoutes)）：
 *   GET  /api/app-update          → app-update.json（版本/下载地址/更新说明）
 *   GET  /api/download/latest.apk → 最新安装包（流式发送）
 *   POST /api/admin/publish-apk   → CI 推送新版 APK（需 Bearer token）
 *   POST /api/admin/publish-notes → CI 推送版本更新说明（需 Bearer token）
 * 注意：本文件内路由为相对路径（/app-update 等），完整路径由 index.ts 的 /api 前缀拼接，
 *       CI 推送时必须带 /api 前缀（见 evereasy 仓库 .github/workflows/build-apk.yml）。
 */
const app = new Hono();

const dir = (): string => process.env.EVEREASY_DOWNLOAD_DIR ?? '/app/data/download';
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN ?? '';

/** 中间件：校验 Bearer token */
async function authGuard(c: any, next: any) {
  const header = c.req.header('Authorization') ?? '';
  if (!PUBLISH_TOKEN || !header.startsWith(`Bearer ${PUBLISH_TOKEN}`)) {
    return c.json({ error: '未授权' }, 401);
  }
  await next();
}

app.get('/app-update', (c) => {
  try {
    const raw = fs.readFileSync(`${dir()}/app-update.json`, 'utf8');
    return c.newResponse(raw, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  } catch {
    return c.json({ error: '暂无更新清单' }, 404);
  }
});

app.get('/download/latest.apk', (c) => {
  const path = `${dir()}/app-release.apk`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    return c.json({ error: '暂无安装包' }, 404);
  }
  const stream = fs.createReadStream(path);
  let ended = false;
  return c.newResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on('data', (chunk) => {
          if (!ended) controller.enqueue(new Uint8Array(chunk as Buffer));
        });
        stream.on('end', () => { if (!ended) { ended = true; controller.close(); } });
        stream.on('error', () => { if (!ended) { ended = true; controller.close(); } });
        stream.on('close', () => { if (!ended) { ended = true; controller.close(); } });
      },
    }),
    200,
    {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="evereasy-${stat.mtime.toISOString().slice(0, 10)}.apk"`,
    },
  );
});

/** CI 推送更新说明 */
app.post('/admin/publish-notes', authGuard, async (c) => {
  try {
    const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
    const d = dir();
    const path = `${d}/app-update.json`;
    let info: Record<string, unknown> = {};
    try { info = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { /* 首次 */ }
    if (body.notes !== undefined) info.notes = body.notes;
    fs.writeFileSync(path, JSON.stringify(info, null, 2));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});
/** CI 推送：接收 APK → 写入分发目录 + 生成 app-update.json */
app.post('/admin/publish-apk', authGuard, async (c) => {
  try {
    const body = await c.req.arrayBuffer();
    const d = dir();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(`${d}/app-release.apk`, Buffer.from(body));

    // 从 header 取版本号（CI 传 X-Version）
    const version = c.req.header('X-Version') ?? 'dev';
    const publicBase = process.env.PUBLIC_BASE ?? 'http://202.189.23.245:42363';
    // 下载地址必须带 /api 前缀，与 index.ts 的挂载前缀一致（App 端据此直链下载）
    const url = `${publicBase}/api/download/latest.apk`;
    const builtAt = new Date().toISOString();
    fs.writeFileSync(`${d}/app-update.json`, JSON.stringify({ version, url, builtAt }, null, 2));
    return c.json({ ok: true, version, builtAt });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});

export default app;

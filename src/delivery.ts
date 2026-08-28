import fs from 'node:fs';
import { Hono } from 'hono';

/**
 * 自有分发通道：
 *   GET /api/app-update          → app-update.json（版本/下载地址，App 内检查更新用）
 *   GET /api/download/latest.apk → 最新安装包（流式发送）
 *   POST /admin/publish-apk       → CI 推送新版 APK（需 Bearer token）
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
        stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        stream.on('end', () => { if (!ended) { ended = true; controller.close(); } });
        stream.on('error', () => { if (!ended) { ended = true; controller.close(); } });
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
    const url = `${publicBase}/download/latest.apk`;
    const builtAt = new Date().toISOString();
    fs.writeFileSync(`${d}/app-update.json`, JSON.stringify({ version, url, builtAt }, null, 2));
    return c.json({ ok: true, version, builtAt });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});

export default app;

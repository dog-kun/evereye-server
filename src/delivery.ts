import fs from 'node:fs';
import { Hono } from 'hono';

/**
 * 自有分发通道：GitHub Actions 构建后把 APK 与版本清单推到宿主机
 * /srv/evereasy-download/（compose 挂载为 /app/data/download），这里对外只读：
 *   GET /api/app-update          → app-update.json（版本/下载地址，App 内检查更新用）
 *   GET /api/download/latest.apk → 最新安装包（流式发送）
 * 无需登录：APK 本就是公开分发物。
 */
const app = new Hono();

const dir = (): string => process.env.EVEREASY_DOWNLOAD_DIR ?? '/app/data/download';

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
  return c.newResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        stream.on('end', () => controller.close());
        stream.on('error', () => controller.close());
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

export default app;

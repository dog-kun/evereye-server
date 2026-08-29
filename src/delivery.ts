import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono, type Context } from 'hono';

/**
 * 自有分发通道（挂载于 /api，见 index.ts: app.route('/api', deliveryRoutes)）：
 *   GET  /api/app-update            → app-update.json（版本/下载地址/更新说明）
 *   GET  /api/download/latest.apk   → 最新安卓安装包（流式发送）
 *   GET  /api/download/latest.exe   → 最新 Windows 安装包（流式发送）
 *   POST /api/admin/publish-apk     → CI 推送新版 APK（需 Bearer token）
 *   POST /api/admin/publish-desktop → CI 推送新版 Windows 安装包（需 Bearer token）
 *   POST /api/admin/publish-notes   → CI 推送版本更新说明（需 Bearer token）
 * 注意：本文件内路由为相对路径（/app-update 等），完整路径由 index.ts 的 /api 前缀拼接，
 *       CI 推送时必须带 /api 前缀（见 evereasy 仓库 .github/workflows/）。
 *
 * 清单读写一律走 readManifest/writeManifest 做「读-改-写」合并：
 * 安卓与桌面两条流水线各自推送、互不相识，整体覆盖会把对方的字段抹掉
 * （曾经的 publish-apk 就是整体覆盖，一旦桌面先推、安卓后推，desktopUrl 就消失）。
 */
const app = new Hono();

const dir = (): string => process.env.EVEREASY_DOWNLOAD_DIR ?? '/app/data/download';
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN ?? '';

/** 分发清单形状（字段全可选：两条流水线各写各的一半） */
interface Manifest {
  /** 安卓版本号 */
  version?: string;
  /** 安卓 APK 直链 */
  url?: string;
  /** 安卓构建时间 */
  builtAt?: string;
  /** Windows 版本号（缺失时桌面端回落读 version） */
  desktopVersion?: string;
  /** Windows 安装包直链 */
  desktopUrl?: string;
  /** Windows 构建时间 */
  desktopBuiltAt?: string;
  /** 更新说明（两端共用） */
  notes?: string;
  [k: string]: unknown;
}

/** 读现有清单（不存在/损坏时返回空对象，保证首次推送也能工作） */
function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(`${dir()}/app-update.json`, 'utf8')) as Manifest;
  } catch {
    return {};
  }
}

/** 合并写回清单（只覆盖 patch 里给出的字段） */
function writeManifest(patch: Manifest): Manifest {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const next = { ...readManifest(), ...patch };
  fs.writeFileSync(`${d}/app-update.json`, JSON.stringify(next, null, 2));
  return next;
}

/** 对外可访问的基地址（生成下载直链用） */
const publicBase = (): string => process.env.PUBLIC_BASE ?? 'http://202.189.23.245:42363';

/**
 * 把请求体流式落盘，全程不把整包读进内存。
 *
 * 桌面安装包上百兆，`await c.req.arrayBuffer()` 会一次性驻留同等大小的 Buffer——
 * 本机总内存 1GB 且已被其他容器占去大半，那样必然 OOM 杀进程。
 * 先写 .tmp 再原子改名：传输中断不会留下半截包被用户下载到。
 */
async function saveBodyToFile(body: ReadableStream<Uint8Array> | null, target: string): Promise<number> {
  if (!body) throw new Error('请求体为空');
  const tmp = `${target}.tmp`;
  fs.mkdirSync(dir(), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
    return fs.statSync(target).size;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp 可能还没建出来 */
    }
    throw e;
  }
}

/** 流式发送一个本地文件（找不到返回 404） */
function sendFile(c: Context, path: string, contentType: string, filename: string) {
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
      cancel() {
        // 客户端中断下载（关页面/断网）：及时销毁读流，否则大文件会一直占着 fd 与磁盘 IO
        ended = true;
        stream.destroy();
      },
    }),
    200,
    {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  );
}

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

app.get('/download/latest.apk', (c) =>
  sendFile(
    c,
    `${dir()}/app-release.apk`,
    'application/vnd.android.package-archive',
    `evereasy-${(readManifest().version ?? 'latest').replace(/[^\w.-]/g, '')}.apk`,
  ),
);

/** Windows 安装包直链（NSIS exe） */
app.get('/download/latest.exe', (c) =>
  sendFile(
    c,
    `${dir()}/evereasy-setup.exe`,
    'application/octet-stream',
    `evereasy-setup-${(readManifest().desktopVersion ?? 'latest').replace(/[^\w.-]/g, '')}.exe`,
  ),
);

/** CI 推送更新说明 */
app.post('/admin/publish-notes', authGuard, async (c) => {
  try {
    const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
    if (body.notes !== undefined) writeManifest({ notes: body.notes });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});

/** CI 推送：接收 APK → 写入分发目录 + 合并更新清单（不动 desktop* 字段） */
app.post('/admin/publish-apk', authGuard, async (c) => {
  try {
    const bytes = await saveBodyToFile(c.req.raw.body, `${dir()}/app-release.apk`);
    const version = c.req.header('X-Version') ?? 'dev';
    const builtAt = new Date().toISOString();
    // 下载地址必须带 /api 前缀，与 index.ts 的挂载前缀一致（App 端据此直链下载）
    writeManifest({ version, url: `${publicBase()}/api/download/latest.apk`, builtAt });
    return c.json({ ok: true, version, builtAt, bytes });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});

/**
 * CI 推送：接收 Windows 安装包 → 写入分发目录 + 合并更新清单（不动安卓字段）。
 *
 * 与 publish-apk 分成两个端点而非共用一个带类型参数的端点：
 * 两条 CI 流水线相互独立、失败互不牵连，路径显式更利于排查推送日志。
 */
app.post('/admin/publish-desktop', authGuard, async (c) => {
  try {
    const bytes = await saveBodyToFile(c.req.raw.body, `${dir()}/evereasy-setup.exe`);
    const desktopVersion = c.req.header('X-Version') ?? 'dev';
    const desktopBuiltAt = new Date().toISOString();
    writeManifest({
      desktopVersion,
      desktopUrl: `${publicBase()}/api/download/latest.exe`,
      desktopBuiltAt,
    });
    return c.json({ ok: true, desktopVersion, desktopBuiltAt, bytes });
  } catch {
    return c.json({ error: '写入失败' }, 500);
  }
});

export default app;

import { Hono } from 'hono';
import { authUserId } from './auth.js';

/**
 * 在线语音识别代理：POST /api/asr
 *
 * App 带同步登录 Bearer 上传 16k 单声道 WAV（multipart 字段 audio），
 * 本路由校验登录后转发给内网 FunASR 容器（docker-compose 服务名 asr），
 * 返回 { text }。音频只在内存过一手，不落盘。
 */
const app = new Hono();

app.post('/asr', async (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '未登录' }, 401);

  const form = await c.req.parseBody().catch(() => null);
  const file = form?.audio;
  if (!(file instanceof File)) return c.json({ error: '缺少 audio 文件' }, 400);
  if (file.size > 8_000_000) return c.json({ error: '音频过大（>8MB）' }, 413);

  const upstream = new FormData();
  upstream.append('audio', new Blob([await file.arrayBuffer()], { type: 'audio/wav' }), 'speech.wav');

  let res: Response;
  try {
    res = await fetch(`${process.env.ASR_INTERNAL_URL ?? 'http://asr:8000'}/asr`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ASR_TOKEN ?? ''}`,
        'X-User-Id': uid,
      },
      body: upstream,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return c.json({ error: '语音服务不可达（容器未启动或仍在加载模型）' }, 502);
  }

  const j = (await res.json().catch(() => null)) as { text?: string } | null;
  if (!res.ok || !j) return c.json({ error: '识别失败' }, 502);
  return c.json(j);
});

export default app;

import { Hono } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { authUserId } from './auth.js';

/**
 * AI 官方通道 · 后端全代理（挂载于 /api/ai）
 *
 * 设计（用户拍板）：App 端零配置 + 单模型硬锁。
 *   - 客户端只请求自家服务器，API Key 配在服务器环境变量，永不随客户端分发；
 *   - 只有「OxAlpha 官方免费通道」一条路：模型固定为 OXALPHA_MODEL（默认 stealth/ox-alpha），
 *     不提供选择其他模型的入口——即使伪造请求带 provider/model 字段也一律忽略，
 *     防止任何人借服务器 Key 消耗其他模型的配额。
 *
 * 安全与健壮性：
 *   - Bearer token 鉴权（复用 sessions 表），AI 能力不对未登录者开放
 *   - 请求体先按文本读入限体积（~200KB）再解析，防超大 body 打爆内存
 *   - messages 形状严格校验（role/content/条数上限）；body 中除 messages/temperature 外
 *     的字段（含 provider、model）全部忽略
 *   - 强制非流式（stream:false），透传上游 JSON 与状态码
 *   - 90 秒超时（AbortSignal.timeout），超时返回 504
 *
 * 环境变量：
 *   - OPENROUTER_API_KEY   必填。AI 功能总开关；这把 OpenRouter Key 仅用于调用下方固定模型。
 *                          缺失时 AI 功能整体不可用（503 + 友好文案）。
 *   - OPENROUTER_BASE_URL  可选。默认 https://openrouter.ai/api/v1
 *   - OXALPHA_MODEL        可选。默认 stealth/ox-alpha
 */

/** 上游基础地址（去尾斜杠；OpenRouter 协议兼容上游） */
function upstreamBase(): string {
  return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
}

/** AI 功能总开关：未配置 Key 时所有代理端点不可用 */
function apiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? key : null;
}

const DEFAULT_MODEL = 'stealth/ox-alpha';

/** 固定模型名（唯一允许通过本服务器调用的模型） */
function fixedModel(): string {
  return process.env.OXALPHA_MODEL?.trim() || DEFAULT_MODEL;
}

/** 客户端允许的对话消息形状 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 校验 messages 形状：非空数组、每项 role/content 合法、条数上限 100。
 * @returns 校验通过返回规范化后的 messages，否则返回失败原因
 */
function validateMessages(
  raw: unknown,
): { ok: true; messages: ChatMessage[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'messages 不能为空' };
  }
  if (raw.length > 100) {
    return { ok: false, reason: 'messages 过多（超过 100 条）' };
  }
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: 'messages 含非法项' };
    }
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, reason: `非法消息 role: ${String(role)}` };
    }
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, reason: 'message.content 不能为空' };
    }
    messages.push({ role, content });
  }
  return { ok: true, messages };
}

const app = new Hono();

/**
 * GET /api/ai/channels —— 查询可用通道与默认模型（设置页展示用）。
 * 登录后才可查询，避免向匿名访客暴露服务器配置状态。
 */
app.get('/channels', (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '未登录' }, 401);

  const configured = apiKey() !== null;
  return c.json({
    /** 服务器是否已配置 AI Key（false 时代理端点均不可用） */
    configured,
    /** 唯一通道 */
    defaultChannel: 'oxalpha',
    channels: [
      { id: 'oxalpha', label: 'OxAlpha 官方通道', model: fixedModel(), available: configured },
    ],
  });
});

/**
 * POST /api/ai/chat —— 非流式 Chat Completions 全代理（固定单模型）。
 * body: { messages, temperature? } —— 其余字段（provider/model 等）一律忽略。
 */
app.post('/chat', async (c) => {
  const uid = authUserId(c.req.header('Authorization'));
  if (!uid) return c.json({ error: '请先登录后再使用 AI 功能' }, 401);

  const key = apiKey();
  if (!key) {
    return c.json({ error: '服务器未配置 OPENROUTER_API_KEY，AI 功能暂不可用' }, 503);
  }

  // 先按文本读取原始体并限体积，再手动解析（防止超大 JSON 打爆内存）
  const raw = await c.req.text();
  if (raw.length > 200_000) {
    return c.json({ error: '请求体过大（>200KB）' }, 413);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: '请求体不是合法 JSON' }, 400);
  }

  const validated = validateMessages(body.messages);
  if (!validated.ok) return c.json({ error: validated.reason }, 400);

  // temperature 可选；越界收敛到 [0,2]。其余字段一律不读——模型被硬锁，无法指定
  const temperature =
    typeof body.temperature === 'number' && Number.isFinite(body.temperature)
      ? Math.min(2, Math.max(0, body.temperature))
      : 0.1;

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        // OpenRouter 归因头（可选）：统计面板里显示调用来源应用
        'X-Title': 'EverEasy',
      },
      body: JSON.stringify({
        model: fixedModel(),
        messages: validated.messages,
        temperature,
        stream: false, // 强制非流式：客户端解析逻辑只消费完整 JSON
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === 'TimeoutError';
    const msg = isTimeout ? '上游 AI 服务超时（90s），请稍后再试' : `连接上游 AI 失败：${String(e)}`;
    return c.json({ error: msg }, 504);
  }

  // 透传上游 JSON 原文与状态码（错误也原样透传，如 401/429/模型不存在等）
  const text = await upstream.text();
  return c.newResponse(text, upstream.status as StatusCode, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  });
});

export default app;

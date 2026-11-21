// DeepSeek Messages API（Anthropic 兼容，/anthropic/v1/messages）
// 只有这个协议会把「思考 / 搜索调用 / 搜索结果 / 正文」作为内容块随流下发，
// 才能还原官方客户端那种边思考边搜索的穿插效果。

export class ApiError extends Error {
  constructor(message, status, kind = 'http') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

export function normalizeBaseUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_BASE_URL;
  return base.replace(/\/(v1|beta)$/, '').replace(/\/anthropic\/v1$/, '');
}

function friendlyHttpError(status, detail) {
  if (status === 401) return 'API Key 无效或已过期（401）';
  if (status === 402) return '账户余额不足（402）';
  if (status === 413) return '请求内容太大（413）';
  if (status === 429) return '请求过于频繁（429），稍后再试';
  if (status === 400 && detail) return `请求被拒绝：${detail.slice(0, 220)}`;
  if (status >= 500) return `服务端错误（${status}），稍后再试`;
  return detail ? `HTTP ${status}：${detail.slice(0, 220)}` : `HTTP ${status}`;
}

function splitDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!match) return null;
  return { mediaType: match[1] || 'image/jpeg', base64: match[3] || '' };
}

/** 消息时间戳 -> "MM-DD HH:mm"（本地时区） */
function formatStamp(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 本地消息 -> Messages API 的 messages */
function buildMessages(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      // 时间前缀：让模型知道这条消息是什么时候发的（能理解"今天/昨天"这类相对时间）
      const stamp = msg.ts ? formatStamp(msg.ts) : '';
      const prefix = stamp ? `[${stamp}] ` : '';
      // txt 附件：文件名打标签 + 全文，拼在用户文字前面
      let text = msg.content || '';
      if (msg.files && msg.files.length) {
        const fileText = msg.files
          .map((f) => `【文件：${f.name}】\n${f.text || ''}`)
          .join('\n\n');
        text = fileText + (text ? '\n\n' + text : '');
      }
      text = prefix + text;
      if (msg.images && msg.images.length) {
        const content = [];
        if (text) content.push({ type: 'text', text });
        for (const img of msg.images) {
          const parsed = splitDataUrl(img.dataUrl);
          if (!parsed) continue;
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64 },
          });
        }
        out.push({ role: 'user', content });
      } else if (text) {
        out.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      if (!msg.content) continue;
      out.push({ role: 'assistant', content: msg.content });
    }
  }
  return out;
}

/**
 * 发起流式对话。事件通过回调逐条抛出，由调用方维护内容块。
 * @param {object} opts
 * @param {(index:number, block:object)=>void} [opts.onBlockStart]
 * @param {(index:number, delta:object)=>void} [opts.onBlockDelta]
 * @param {(index:number)=>void} [opts.onBlockStop]
 * @param {(title:string)=>void} [opts.onTitle]
 * @param {(usage:object)=>void} [opts.onUsage]
 */
export async function streamMessage(opts) {
  const {
    apiKey, baseUrl, model, history, systemPrompt, thinking, search, wantTitle,
    temperature, signal, onBlockStart, onBlockDelta, onBlockStop, onTitle, onUsage, onStop,
  } = opts;

  if (!apiKey) throw new ApiError('还没有填写 API Key', 0, 'auth');

  const url = `${normalizeBaseUrl(baseUrl)}/anthropic/v1/messages`;
  const payload = {
    model: model || DEFAULT_MODEL,
    messages: buildMessages(history),
    stream: true,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (Number.isFinite(Number(temperature))) payload.temperature = Number(temperature);
  if (systemPrompt) payload.system = systemPrompt;
  if (wantTitle) payload.title = { enabled: true };
  if (search) {
    payload.tools = [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    ];
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('网络请求失败。检查网络、接口地址，或该地址是否允许浏览器跨域访问', 0, 'network');
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch { /* 忽略 */ }
    let message = friendlyHttpError(response.status, '');
    try {
      const parsed = JSON.parse(detail);
      if (parsed && parsed.error && parsed.error.message) {
        message = friendlyHttpError(response.status, parsed.error.message);
      }
    } catch { /* 非 JSON */ }
    throw new ApiError(message, response.status, 'http');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('服务端没有返回流式响应（可能不是 DeepSeek 兼容接口）', 0, 'protocol');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const raw = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');

        if (!raw) {
          eventName = '';
          continue;
        }
        if (raw.startsWith(':')) continue;               // keep-alive
        if (raw.startsWith('event:')) {
          eventName = raw.slice(6).trim();
          continue;
        }
        if (!raw.startsWith('data:')) continue;

        const data = raw.slice(5).trim();
        if (!data) continue;

        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        const kind = evt.type || eventName;

        if (kind === 'error') {
          const message = (evt.error && evt.error.message) || '服务端返回错误';
          throw new ApiError(message, 0, 'stream');
        }
        if (kind === 'message_start') {
          if (evt.message && evt.message.usage && onUsage) onUsage(evt.message.usage);
          continue;
        }
        if (kind === 'content_block_start') {
          if (onBlockStart) onBlockStart(evt.index, evt.content_block || {});
          continue;
        }
        if (kind === 'content_block_delta') {
          if (onBlockDelta) onBlockDelta(evt.index, evt.delta || {});
          continue;
        }
        if (kind === 'content_block_stop') {
          if (onBlockStop) onBlockStop(evt.index);
          continue;
        }
        if (kind === 'message_delta') {
          if (evt.usage && onUsage) onUsage(evt.usage);
          if (evt.delta && evt.delta.stop_reason && onStop) onStop(evt.delta.stop_reason);
          if (evt.delta && evt.delta.title && onTitle) onTitle(evt.delta.title);
          continue;
        }
        if (kind === 'message_stop') return;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略 */ }
  }
}

/** 用 GET /models 校验 Key，不产生费用 */
export async function verifyKey(apiKey, baseUrl) {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new ApiError(friendlyHttpError(res.status, ''), res.status, 'http');
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

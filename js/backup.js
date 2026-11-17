// 官方历史格式兼容：export_format_version = 3 的 ZIP 归档
// 结构：manifest.json / chat_sessions/{id}.json / chat_session_index.json / chat_sessions/{id}_files/...
// 文档见 deepseek-ai/chat-demo: src/services/chat/history/README.md

export const EXPORT_FORMAT_VERSION = 3;

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ ZIP 写入 ------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date: day };
}

/**
 * 生成 ZIP（STORE，不压缩）。文件小、实现简单，官方客户端也能读。
 * @param {{name: string, data: Uint8Array|string}[]} entries
 */
export function makeZip(entries) {
  const now = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 文件名
    lv.setUint16(8, 0, true);           // STORE
    lv.setUint16(10, now.time, true);
    lv.setUint16(12, now.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, now.time, true);
    cv.setUint16(14, now.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

/* ------------------------------ ZIP 读取 ------------------------------ */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前系统太旧，无法解压此 ZIP。请升级系统，或先在其他设备上解压出 JSON');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读取 ZIP，返回 { [name]: Uint8Array } */
export async function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // 从末尾找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效的 ZIP 文件');

  const total = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const files = {};

  for (let n = 0; n < total; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    files[name] = method === 0 ? raw : await inflateRaw(raw);

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ------------------------------ 转换 ------------------------------ */

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseIso(text) {
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : Date.now();
}

function pickText(fragments, type) {
  const hit = fragments.find((f) => f.type === type);
  return hit ? hit.content || '' : '';
}

/** 本地会话 -> 归档会话 JSON */
function sessionToArchive(session) {
  const messages = [];
  let parent = null;
  let id = 0;
  const files = [];

  for (const msg of session.messages) {
    id += 1;
    const fragments = [];
    if (msg.role === 'user') {
      if (msg.images && msg.images.length) {
        fragments.push({
          type: 'FILE',
          files: msg.images.map((img) => {
            const fid = `${session.id}-${img.id}`;
            const fileName = img.name || 'image.jpg';
            const exportPath = `chat_sessions/${session.id}_files/${fid}_${fileName}`;
            files.push({ path: exportPath, dataUrl: img.dataUrl });
            return {
              id: fid,
              file_name: fileName,
              file_size: img.size || 0,
              token_usage: null,
              inserted_at: iso(msg.ts || Date.now()),
              export_path: exportPath,
              is_image: true,
              width: img.width || null,
              height: img.height || null,
            };
          }),
        });
      }
      fragments.push({ type: 'REQUEST', content: msg.content || '' });
    } else {
      if (msg.reasoning) {
        fragments.push({
          type: 'THINK',
          content: msg.reasoning,
          elapsed_secs: msg.elapsedSecs ?? null,
        });
      }
      fragments.push({ type: 'RESPONSE', content: msg.content || '' });
    }

    messages.push({
      id,
      parent_id: parent,
      role: msg.role === 'user' ? 'USER' : 'ASSISTANT',
      status: 'FINISHED',
      thinking_enabled: !!msg.thinking,
      search_enabled: !!msg.search,
      accumulated_token_usage: 0,
      inserted_at: iso(msg.ts || Date.now()),
      fragments,
    });
    parent = id;
  }

  return {
    session: {
      id: session.id,
      title: session.title || null,
      pinned: false,
      current_message_id: id,
      inserted_at: iso(session.createdAt || Date.now()),
      updated_at: iso(session.updatedAt || Date.now()),
      messages,
    },
    files,
  };
}

export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  const binary = isBase64 ? atob(body) : decodeURIComponent(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** 导出全部会话为官方格式 ZIP */
export function exportArchive(sessions) {
  const entries = [];
  const index = [];

  entries.push({
    name: 'manifest.json',
    data: JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION }, null, 2),
  });

  for (const session of sessions) {
    if (!session.messages || !session.messages.length) continue;
    const { session: archive, files } = sessionToArchive(session);
    entries.push({
      name: `chat_sessions/${session.id}.json`,
      data: JSON.stringify(archive, null, 2),
    });
    for (const file of files) {
      entries.push({ name: file.path, data: dataUrlToBytes(file.dataUrl) });
    }
    index.push({
      id: session.id,
      title: session.title || null,
      message_count: session.messages.length,
      inserted_at: iso(session.createdAt || Date.now()),
      updated_at: iso(session.updatedAt || Date.now()),
    });
  }

  entries.push({ name: 'chat_session_index.json', data: JSON.stringify(index, null, 2) });

  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `deepseek_data-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.zip`;
  return { blob: makeZip(entries), name };
}

/** 沿 current_message_id 回溯出当前分支 */
function pathFromCurrent(messages, currentId) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out = [];
  let node = byId.get(currentId);
  while (node) {
    out.push(node);
    node = node.parent_id == null ? undefined : byId.get(node.parent_id);
  }
  return out.reverse();
}

function findParentFile(messages, child) {
  // FILE 片段在用户消息里，按 id 找到当前分支上的用户消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id <= child.id && messages[i].role === 'USER') return messages[i];
  }
  return null;
}

/** 归档会话 -> 本地会话 */
function archiveToSession(archive, files, fallbackTitle) {
  const messages = pathFromCurrent(archive.messages || [], archive.current_message_id);
  const out = [];
  let previousUser = null;

  for (const msg of messages) {
    const frags = Array.isArray(msg.fragments) ? msg.fragments : [];
    if (msg.role === 'USER') {
      const images = [];
      const fileFrag = frags.find((f) => f.type === 'FILE');
      if (fileFrag && Array.isArray(fileFrag.files)) {
        for (const f of fileFrag.files) {
          const entry = f.export_path && files[f.export_path];
          if (!entry) continue;
          let mime = 'image/jpeg';
          if (/\.png$/i.test(f.file_name || '')) mime = 'image/png';
          else if (/\.webp$/i.test(f.file_name || '')) mime = 'image/webp';
          else if (/\.gif$/i.test(f.file_name || '')) mime = 'image/gif';
          images.push({
            id: String(f.id || images.length),
            name: f.file_name || 'image',
            size: f.file_size || entry.length,
            dataUrl: bytesToDataUrl(entry, mime),
          });
        }
      }
      const item = {
        id: `u_${msg.id}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        content: pickText(frags, 'REQUEST'),
        images,
        ts: parseIso(msg.inserted_at),
      };
      out.push(item);
      previousUser = item;
    } else if (msg.role === 'ASSISTANT') {
      if (!previousUser) continue;
      out.push({
        id: `a_${msg.id}_${Math.random().toString(36).slice(2, 7)}`,
        role: 'assistant',
        content: pickText(frags, 'RESPONSE'),
        reasoning: pickText(frags, 'THINK'),
        thinking: !!msg.thinking_enabled,
        search: !!msg.search_enabled,
        ts: parseIso(msg.inserted_at),
      });
    }
  }

  return {
    id: String(archive.id || `imported_${Date.now().toString(36)}`),
    title: archive.title || fallbackTitle || '导入的对话',
    createdAt: parseIso(archive.inserted_at),
    updatedAt: parseIso(archive.updated_at),
    pinned: false,
    messages: out,
  };
}

/** 导入官方格式 ZIP */
export async function importArchive(file) {
  const buffer = await file.arrayBuffer();
  const files = await readZip(buffer);

  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new Error('缺少 manifest.json，不是 DeepSeek 导出的归档');
  let manifest;
  try {
    manifest = JSON.parse(dec.decode(manifestRaw));
  } catch {
    throw new Error('manifest.json 无法解析');
  }
  if (manifest.export_format_version > EXPORT_FORMAT_VERSION) {
    throw new Error(`归档版本 ${manifest.export_format_version} 比当前客户端新，请更新后再导入`);
  }

  let index = [];
  if (files['chat_session_index.json']) {
    try {
      index = JSON.parse(dec.decode(files['chat_session_index.json']));
    } catch { /* 索引坏了不影响主数据 */ }
  }
  const titleById = new Map(
    (Array.isArray(index) ? index : []).map((s) => [String(s.id), s.title])
  );

  const sessions = [];
  for (const name of Object.keys(files)) {
    const match = /^chat_sessions\/([^/]+)\.json$/.exec(name);
    if (!match) continue;
    const id = match[1];
    let archive;
    try {
      archive = JSON.parse(dec.decode(files[name]));
    } catch {
      continue;
    }
    sessions.push(archiveToSession(archive, files, titleById.get(id)));
  }

  if (!sessions.length) throw new Error('归档里没有找到任何会话');

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

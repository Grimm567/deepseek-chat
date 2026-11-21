// 极简 Markdown 渲染器（无依赖）
// 支持：标题、段落、粗体/斜体/删除线、行内代码、代码块（含轻量高亮）、
//       有序/无序列表、引用、表格、分割线、链接、图片。
// 所有输出均经过 HTML 转义，链接协议白名单校验。

const SAFE_URL = /^(?:https?:\/\/|mailto:|#|\/|\.\/)/i;

function safeUrl(raw) {
  const url = String(raw).trim().replace(/^<|>$/g, '');
  return SAFE_URL.test(url) ? url : '#';
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/* ------------------------------- 代码高亮 ------------------------------- */

const RE = {
  lineComment: /\/\/[^\n]*/,
  blockComment: /\/\*[\s\S]*?\*\//,
  hashComment: /#[^\n]*/,
  strJs: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/,
  strPy: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
  strPlain: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/,
  number: /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b/,
  htmlTag: /<\/?[A-Za-z][\w:-]*/,
  htmlComment: /<!--[\s\S]*?-->/,
};

const JS_KW = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'class', 'extends', 'new', 'import', 'export', 'default', 'await', 'async',
  'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'this',
  'super', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break',
  'continue', 'delete', 'void', 'yield', 'static', 'interface', 'type', 'enum',
  'implements', 'readonly', 'as'];

const PY_KW = ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'None',
  'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'break', 'continue',
  'yield', 'global', 'nonlocal', 'assert', 'del', 'async', 'await'];

const SH_KW = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'return', 'in', 'echo', 'cd', 'export', 'local', 'sudo',
  'exit', 'set', 'source'];

function kwPattern(words) {
  return `\\b(?:${words.join('|')})\\b`;
}

function specFor(lang) {
  const jsLike = {
    patterns: [
      { src: RE.lineComment.source, cls: 'tk-c' },
      { src: RE.blockComment.source, cls: 'tk-c' },
      { src: RE.strJs.source, cls: 'tk-s' },
      { src: RE.number.source, cls: 'tk-n' },
      { src: kwPattern(JS_KW), cls: 'tk-k' },
    ],
  };
  const py = {
    patterns: [
      { src: RE.hashComment.source, cls: 'tk-c' },
      { src: RE.strPy.source, cls: 'tk-s' },
      { src: RE.number.source, cls: 'tk-n' },
      { src: kwPattern(PY_KW), cls: 'tk-k' },
    ],
  };
  const sh = {
    patterns: [
      { src: RE.hashComment.source, cls: 'tk-c' },
      { src: RE.strPlain.source, cls: 'tk-s' },
      { src: RE.number.source, cls: 'tk-n' },
      { src: kwPattern(SH_KW), cls: 'tk-k' },
    ],
  };
  const json = {
    patterns: [
      { src: RE.strPlain.source, cls: 'tk-s' },
      { src: RE.number.source, cls: 'tk-n' },
      { src: '\\b(?:true|false|null)\\b', cls: 'tk-k' },
    ],
  };
  const css = {
    patterns: [
      { src: RE.blockComment.source, cls: 'tk-c' },
      { src: RE.strPlain.source, cls: 'tk-s' },
      { src: RE.number.source, cls: 'tk-n' },
      { src: '[.#]?[A-Za-z-]+(?=\\s*[:{])', cls: 'tk-k' },
    ],
  };
  const html = {
    patterns: [
      { src: RE.htmlComment.source, cls: 'tk-c' },
      { src: RE.htmlTag.source, cls: 'tk-k' },
      { src: RE.strPlain.source, cls: 'tk-s' },
    ],
  };

  switch (lang) {
    case 'js':
    case 'javascript':
    case 'ts':
    case 'typescript':
    case 'jsx':
    case 'tsx':
    case 'mjs':
    case 'node':
      return jsLike;
    case 'py':
    case 'python':
      return py;
    case 'sh':
    case 'bash':
    case 'shell':
    case 'zsh':
    case 'console':
    case 'powershell':
    case 'ps1':
      return sh;
    case 'json':
      return json;
    case 'css':
    case 'scss':
    case 'less':
      return css;
    case 'html':
    case 'xml':
    case 'svg':
      return html;
    default:
      return null;
  }
}

// 单遍扫描：每次在所有模式中取“最早出现”的匹配，避免字符串/注释内部被误高亮。
export function highlightCode(code, lang) {
  const spec = specFor(lang);
  if (!spec) return escapeHtml(code);

  const matchers = spec.patterns.map((p) => ({
    re: new RegExp(p.src, 'g'),
    cls: p.cls,
  }));

  let out = '';
  let pos = 0;
  const text = String(code);

  while (pos < text.length) {
    let best = null;
    for (const m of matchers) {
      m.re.lastIndex = pos;
      const found = m.re.exec(text);
      if (!found || found[0] === '') continue;
      if (!best || found.index < best.index) {
        best = { index: found.index, text: found[0], cls: m.cls };
      }
    }
    if (!best) break;
    if (best.index > pos) out += escapeHtml(text.slice(pos, best.index));
    out += `<span class="${best.cls}">${escapeHtml(best.text)}</span>`;
    pos = best.index + best.text.length;
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

/* ------------------------------- 行内语法 ------------------------------- */

/** 把 escapeHtml 转过的实体还原：行内公式的 tex 是转义过的文本，KaTeX 需要原始字符 */
function unescapeHtml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 公式渲染缓存：流式输出每帧都重建整条消息，没有缓存时同一批公式会被反复渲染 */
const mathCache = new Map();

/** 用 KaTeX 渲染公式；未加载时降级为等宽文本 */
function mathHtml(tex, display) {
  const raw = unescapeHtml(tex || '').trim();
  const katex = typeof window !== 'undefined' ? window.katex : null;
  if (!katex || typeof katex.renderToString !== 'function') {
    // 降级结果不进缓存：KaTeX 迟到后需要重新渲染出真正的公式
    return `<code class="math-raw">${escapeHtml(raw)}</code>`;
  }
  const key = (display ? 'B' : 'I') + '\u0000' + raw;
  const cached = mathCache.get(key);
  if (cached) return cached;

  let html;
  try {
    html = katex.renderToString(raw, {
      displayMode: !!display,
      throwOnError: false,
      strict: 'ignore',
      // 只输出 HTML：KaTeX 默认同时吐一份 MathML，DOM 体积翻倍，长对话滚动会明显变沉
      output: 'html',
    });
  } catch {
    html = `<code class="math-raw">${escapeHtml(raw)}</code>`;
  }
  if (mathCache.size >= 400) mathCache.clear();
  mathCache.set(key, html);
  return html;
}

function inline(text, stash) {
  const token = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = text;

  // 行内代码优先，避免内部内容再被解释
  s = s.replace(/`([^`\n]+)`/g, (_, code) => token(`<code class="inline-code">${code}</code>`));

  // 行内公式 $...$ 或 \(...\)
  s = s.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (m, pre, tex) => `${pre}${token(mathHtml(tex, false))}`);
  s = s.replace(/\\\(([^\n]+?)\\\)/g, (m, tex) => token(mathHtml(tex, false)));

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, url) => token(`<img class="md-img" src="${safeUrl(url)}" alt="${alt}" loading="lazy" decoding="async">`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_, label, url) => token(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`));

  // 脚注引用 [^1]
  s = s.replace(/\[\^([^\]\s]+)\]/g, (_, id) =>
    token(`<sup class="fn-ref"><a href="#fn-${escapeHtml(id)}" id="fnref-${escapeHtml(id)}">[${escapeHtml(id)}]</a></sup>`)
  );

  // 加粗分档：****大标题**** / ***小标题*** / **普通加粗**
  s = s.replace(/\*{4}([^*\n]+)\*{4}/g, (_, t) => `<strong class="tier-lg">${t}</strong>`);
  s = s.replace(/\*{3}([^*\n]+)\*{3}/g, (_, t) => `<strong class="tier-md">${t}</strong>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  // 裸链接 / 邮箱自动识别
  s = s.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>()"'，。；、！？（）]+)/g,
    (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/(^|[\s(（])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (_, pre, mail) => `${pre}<a href="mailto:${mail}">${mail}</a>`);

  for (let n = 0; n < 3; n++) {
    const before = s;
    s = s.replace(/\u0000(\d+)\u0000/g, (m, idx) => stash[Number(idx)] ?? m);
    if (s === before) break;
  }
  return s;
}

/* ------------------------------- 块级语法 ------------------------------- */

function isTableSep(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(row) {
  return String(row).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function tableAlign(sep) {
  return splitRow(sep).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

function renderTable(header, sep, rows, stash) {
  const aligns = tableAlign(sep);
  const cell = (tag, text, index) => {
    const align = aligns[index] ? ` style="text-align:${aligns[index]}"` : '';
    return `<${tag}${align}>${inline(escapeHtml(text), stash)}</${tag}>`;
  };
  const thead = `<thead><tr>${header.map((t, i) => cell('th', t, i)).join('')}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${r.map((t, i) => cell('td', t, i)).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

const BLOCK_START = /^\s*(?:#{1,6}\s|\u0002\d+\u0002\s*$|>|[-*+]\s|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

export function renderMarkdown(src) {
  if (src === null || src === undefined) return '';
  const stash = [];
  let text = String(src).replace(/\r\n?/g, '\n');

  // 先抽出代码块，避免块级解析干扰
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, info, code) => {
    const lang = (info.trim().split(/\s+/)[0] || '').toLowerCase();
    const body = highlightCode(code.replace(/\n$/, ''), lang);
    const label = escapeHtml(lang || 'text');
    stash.push(`<div class="code"><div class="code-bar"><span class="code-lang">${label}</span><button class="code-copy" type="button">复制</button></div><pre><code>${body}</code></pre></div>`);
    return `\u0002${stash.length - 1}\u0002\n`;
  });

  // 有的接口会把反斜杠再转义一层，出现 \\(...\\) / \\[...\\] 这种写法。
  // 只归一“成对出现”的定界符，绝不能碰 LaTeX 自己的 \\[8pt]（换行间距）这类命令，
  // 否则公式里会冒出 \ 后跟 [8pt] 的乱码，KaTeX 直接报错整段显示红色。
  text = text.replace(/\\\\\(([\s\S]*?)\\\\\)/g, (m, tex) => `\\(${tex}\\)`);
  text = text.replace(/\\\\\[([\s\S]*?)\\\\\]/g, (m, tex) => `\\[${tex}\\]`);

  // 收集脚注定义 [^id]: 内容，并从正文移除
  const footnotes = [];
  text = text.replace(/^\s*\[\^([^\]\s]+)\]:\s*(.*)$/gm, (_, id, content) => {
    footnotes.push({ id, content });
    return '';
  });

  // 块级公式 $$...$$ 与 \[...\]（后者是 DeepSeek 官方模型更常用的写法）
  const blockMath = (tex) => {
    stash.push(mathHtml(tex, true));
    return `\u0002${stash.length - 1}\u0002\n`;
  };
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => blockMath(tex));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => blockMath(tex));

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  const paragraph = (buf) => {
    if (!buf.length) return;
    const html = inline(escapeHtml(buf.join('\n')), stash).replace(/\n/g, '<br>');
    out.push(`<p>${html}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const trimmed = line.trim();

    if (/^\u0002\d+\u0002$/.test(trimmed)) { out.push(trimmed); i++; continue; }

    let m = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${inline(escapeHtml(m[2]), stash)}</h${level}>`);
      i++; continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr>'); i++; continue; }

    if (/^>/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const html = inline(escapeHtml(buf.join('\n')), stash).replace(/\n/g, '<br>');
      out.push(`<blockquote>${html}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*+]\s+/, '');
        // 模型常把普通列表也写成任务列表语法（- [ ] / - [x]）。对话里没有「勾选待办」
        // 这件事，所以统一按普通列表渲染；[x] 只保留“已完成”的淡化划线。
        const task = /^\[([ xX])\]\s*(.*)$/.exec(raw);
        items.push(task
          ? { done: task[1].toLowerCase() === 'x', text: task[2] }
          : { done: false, text: raw });
        i++;
      }
      out.push(`<ul>${items.map((it) =>
        `<li${it.done ? ' class="task-done"' : ''}>${inline(escapeHtml(it.text), stash)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(escapeHtml(t), stash)}</li>`).join('')}</ol>`);
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const sep = lines[i + 1];
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(renderTable(header, sep, rows, stash));
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    paragraph(buf);
  }

  if (footnotes.length) {
    out.push(`<section class="footnotes"><ol>${footnotes.map((f) =>
      `<li id="fn-${escapeHtml(f.id)}">${inline(escapeHtml(f.content), stash)}</li>`).join('')}</ol></section>`);
  }

  return out.join('\n').replace(/\u0002(\d+)\u0002/g, (_, idx) => stash[Number(idx)] ?? '');
}

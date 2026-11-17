import { renderMarkdown } from './markdown.js';
import { streamMessage, verifyKey, ApiError, DEFAULT_BASE_URL, DEFAULT_MODEL } from './api.js';
import * as db from './db.js';
import { exportArchive, importArchive } from './backup.js';

/* ------------------------------ 设置 ------------------------------ */

const SETTINGS_KEY = 'ds.settings';
const DEFAULTS = {
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  systemPrompt: '',
  theme: 'auto',
  think: false,
  search: false,
  temperature: 1,
};

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* 隐私模式 */ }
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  settings: loadSettings(),
  sessions: [],
  currentId: null,
  streaming: false,
  controller: null,
  draftImages: [],
  query: '',
  selectMode: false,
  selected: new Set(),
};

const $ = (id) => document.getElementById(id);
const dom = {
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  convList: $('convScroll'),
  search: $('searchInput'),
  welcome: $('welcome'),
  messages: $('messages'),
  chat: $('chat'),
  input: $('input'),
  topTitle: $('topTitle'),
  btnMenu: $('btnMenu'),
  btnNew: $('btnNew'),
  btnSend: $('btnSend'),
  btnStop: $('btnStop'),
  btnAttach: $('btnAttach'),
  btnThink: $('btnThink'),
  btnSearch: $('btnSearch'),
  btnSettings: $('btnSettings'),
  btnScrollBottom: $('btnScrollBottom'),
  sheet: $('sheet'),
  sheetPanel: $('sheetPanel'),
  modal: $('settingsModal'),
  toast: $('toast'),
  imageInput: $('imageInput'),
  archiveInput: $('archiveInput'),
  composer: $('composer'),
};

/* ------------------------------ 工具 ------------------------------ */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message, ms = 2200) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, ms);
}

function fmtGroup(ts) {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - 86400000) return '昨天';
  if (ts >= startOfToday - 7 * 86400000) return '7 天内';
  if (ts >= startOfToday - 30 * 86400000) return '30 天内';
  return '更早';
}

/* ------------------------------ 系统提示词 ------------------------------ */

function currentTimeText() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())} 星期${week}（${tz}）`;
}

/** 每次请求动态拼系统提示词：身份 + 用户自定义 + 当前时间 + 工具说明 */
function composeSystemPrompt() {
  const parts = ['你是 DeepSeek，由深度求索公司创造的 AI 助手。'];

  const custom = (state.settings.systemPrompt || '').trim();
  if (custom) parts.push(custom);

  parts.push(`当前时间：${currentTimeText()}。涉及"今天""最近""现在"这类表述时以此为准。`);

  if (state.settings.search) {
    parts.push(
      '你已开启联网能力：可用 deepseek_web_search 搜索网页、用 deepseek_read_url 阅读用户给出的链接。'
      + '遇到需要最新信息、实时数据或你不确定的事实时，主动检索并在回答里给出引用来源。'
    );
  } else {
    parts.push('本次对话没有联网工具，遇到需要实时信息的问题，说明你的知识截止时间再作答。');
  }

  parts.push('回答使用 Markdown，代码用带语言标注的代码块。');
  return parts.join('\n\n');
}

function applyTheme() {  const pref = state.settings.theme;
  const dark = pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#121317' : '#ffffff');
}

function currentSession() {
  return state.sessions.find((s) => s.id === state.currentId) || null;
}

function touchSession(session) {
  session.updatedAt = Date.now();
  state.sessions.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

function persist(session) {
  db.putSession(session).catch(() => toast('本地保存失败，可能是存储空间不足'));
}

/* ------------------------------ 侧栏 ------------------------------ */

function renderSidebar() {
  dom.convList.innerHTML = '';

  if (state.selectMode) {
    const bar = el('div', 'select-bar');
    const cancel = el('button', 'select-btn', '取消');
    cancel.addEventListener('click', exitSelectMode);
    bar.appendChild(cancel);
    bar.appendChild(el('span', 'select-count', `已选 ${state.selected.size}`));
    const remove = el('button', 'select-btn danger', '删除');
    remove.addEventListener('click', deleteSelected);
    bar.appendChild(remove);
    dom.convList.appendChild(bar);
  }

  const q = state.query.trim().toLowerCase();
  const list = state.sessions.filter((s) => {
    if (!q) return true;
    if ((s.title || '').toLowerCase().includes(q)) return true;
    return s.messages.some((m) => (m.content || '').toLowerCase().includes(q));
  });

  if (!list.length) {
    dom.convList.appendChild(el('div', 'side-empty', q ? '没有匹配的对话' : '还没有对话'));
    return;
  }

  const groups = new Map();
  for (const s of list) {
    const key = s.pinned ? '置顶' : fmtGroup(s.updatedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const order = ['置顶', '今天', '昨天', '7 天内', '30 天内', '更早'];
  for (const key of order) {
    const items = groups.get(key);
    if (!items || !items.length) continue;
    dom.convList.appendChild(el('div', 'group-title', key));
    for (const s of items) {
      const row = el('div', 'conv' + (s.id === state.currentId && !state.selectMode ? ' active' : ''));

      if (state.selectMode) {
        const box = el('span', 'checkbox' + (state.selected.has(s.id) ? ' checked' : ''));
        row.appendChild(box);
      }

      row.appendChild(el('span', 'conv-title', s.title || '新对话'));

      if (state.selectMode) {
        row.addEventListener('click', () => {
          if (state.selected.has(s.id)) state.selected.delete(s.id);
          else state.selected.add(s.id);
          renderSidebar();
        });
      } else {
        row.addEventListener('click', () => {
          state.currentId = s.id;
          state.draftImages = [];
          closeSidebar();
          renderAll();
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openSessionMenu(s);
        });
        bindLongPress(row, () => openSessionMenu(s));
      }
      dom.convList.appendChild(row);
    }
  }
}

function enterSelectMode(session) {
  state.selectMode = true;
  state.selected = new Set(session ? [session.id] : []);
  renderSidebar();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected = new Set();
  renderSidebar();
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('先选中对话');
    return;
  }
  if (!window.confirm(`删除选中的 ${ids.length} 个对话？`)) return;
  for (const id of ids) {
    await db.deleteSession(id).catch(() => {});
  }
  state.sessions = state.sessions.filter((s) => !ids.includes(s.id));
  if (ids.includes(state.currentId)) state.currentId = null;
  exitSelectMode();
  renderAll();
  toast(`已删除 ${ids.length} 个对话`);
}

function openSessionMenu(session) {
  const items = [
    {
      label: '重命名',
      icon: 'pencil',
      run: () => {
        const title = window.prompt('重命名对话', session.title || '');
        if (title === null) return;
        session.title = title.trim() || '未命名';
        touchSession(session);
        persist(session);
        renderAll();
      },
    },
    {
      label: session.pinned ? '取消置顶' : '置顶',
      icon: 'pin',
      run: () => {
        session.pinned = !session.pinned;
        touchSession(session);
        persist(session);
        renderAll();
      },
    },
    {
      label: '多选',
      icon: 'check',
      run: () => enterSelectMode(session),
    },
    {
      label: '删除',
      icon: 'trash',
      danger: true,
      run: async () => {
        if (!window.confirm(`删除「${session.title || '新对话'}」？`)) return;
        await db.deleteSession(session.id).catch(() => {});
        state.sessions = state.sessions.filter((s) => s.id !== session.id);
        if (state.currentId === session.id) state.currentId = null;
        renderAll();
      },
    },
  ];
  openSheet(items);
}

/* ------------------------------ 消息 ------------------------------ */

const ROOT_KEY = 'root';

function parentKeyOf(msg) {
  return msg.parentId || ROOT_KEY;
}

/** 同一父节点下的所有消息，按插入顺序 */
function siblingsOf(session, msg) {
  const key = parentKeyOf(msg);
  return session.messages.filter((m) => parentKeyOf(m) === key);
}

/**
 * 当前生效的对话路径：从根出发，每层取被选中的节点，一路走到叶子。
 * 切版本就是改 session.choice，后续对话会自动跟着换分支。
 */
function currentPath(session) {
  const choice = session.choice || {};
  const out = [];
  let key = ROOT_KEY;
  for (let guard = 0; guard < 500; guard++) {
    const kids = session.messages.filter((m) => parentKeyOf(m) === key);
    if (!kids.length) break;
    const chosen = kids.find((m) => m.id === choice[key]) || kids[kids.length - 1];
    out.push(chosen);
    key = chosen.id;
  }
  return out;
}

function selectSibling(session, members, nextIndex) {
  const target = members[nextIndex];
  if (!target) return;
  if (!session.choice) session.choice = {};
  session.choice[parentKeyOf(target)] = target.id;
  persist(session);
  renderMessages();
}

/** 版本切换控件：‹ 2/3 › */
function appendVariants(wrap, session, msg, info) {
  if (!info || !info.members || info.members.length < 2) return;
  const bar = el('div', 'variants');
  const prev = el('button', 'var-btn', '‹');
  prev.disabled = info.index <= 0;
  prev.addEventListener('click', () => selectSibling(session, info.members, info.index - 1));
  const label = el('span', 'var-label', `${info.index + 1}/${info.members.length}`);
  const next = el('button', 'var-btn', '›');
  next.disabled = info.index >= info.members.length - 1;
  next.addEventListener('click', () => selectSibling(session, info.members, info.index + 1));
  bar.appendChild(prev);
  bar.appendChild(label);
  bar.appendChild(next);
  wrap.appendChild(bar);
}

/** 老数据没有 parentId：按数组顺序连成一条链 */
function migrateSessions(list) {
  for (const session of list) {
    if (!Array.isArray(session.messages)) session.messages = [];
    let prev = null;
    for (const msg of session.messages) {
      if (!msg.parentId && prev) msg.parentId = prev.id;
      prev = msg;
    }
    if (!session.choice) session.choice = {};
  }
}

function renderAll() {
  const session = currentSession();
  const hasMessages = !!(session && session.messages.length);

  dom.welcome.hidden = hasMessages;
  dom.messages.hidden = !hasMessages;
  dom.topTitle.textContent = session ? (session.title || '新对话') : '新对话';

  dom.btnThink.classList.toggle('on', !!state.settings.think);
  dom.btnSearch.classList.toggle('on', !!state.settings.search);
  dom.btnThink.setAttribute('aria-pressed', String(!!state.settings.think));
  dom.btnSearch.setAttribute('aria-pressed', String(!!state.settings.search));

  renderSidebar();
  if (hasMessages) renderMessages();
  else dom.messages.innerHTML = '';
  updateSendButton();
  scrollToBottom(true);
}

function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';
const ICON_PAGE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M8 9h8M8 13h6"></path></svg>';

/** 思考区里的一行工具步骤：搜索到 N 个网页 / 已浏览页面 */
function toolStepRow(iconSvg, text, hosts) {
  const row = el('div', 'tool-step');
  const icon = el('span', 'tool-ico');
  icon.innerHTML = iconSvg;
  row.appendChild(icon);
  row.appendChild(el('span', 'tool-text', text));

  if (hosts && hosts.length) {
    const sites = el('span', 'tool-sites');
    for (const host of hosts.slice(0, 3)) {
      const dot = el('span', 'site-dot', host.slice(0, 1).toUpperCase());
      dot.title = host;
      sites.appendChild(dot);
    }
    row.appendChild(sites);
  }
  return row;
}

function renderTimeline(container, items) {
  let openCount = 0;
  const flushOpen = () => {
    if (!openCount) return;
    container.appendChild(
      toolStepRow(ICON_PAGE, openCount > 1 ? `已浏览 ${openCount} 个页面` : '已浏览页面', [])
    );
    openCount = 0;
  };

  for (const item of items) {
    if (item.type === 'thinking') {
      flushOpen();
      if (item.text) {
        const seg = el('div', 'think-seg');
        seg.innerHTML = renderMarkdown(item.text);
        container.appendChild(seg);
      }
    } else if (item.type === 'search') {
      flushOpen();
      const sources = item.sources || [];
      const hosts = [...new Set(sources.map((s) => siteHost(s.url)).filter(Boolean))];
      container.appendChild(toolStepRow(ICON_SEARCH, `搜索到 ${sources.length} 个网页`, hosts));
    } else if (item.type === 'open') {
      openCount += 1;
    }
  }
  flushOpen();
}

function messageNode(msg, index, session, variantInfo) {
  const wrap = el('div', 'msg ' + (msg.role === 'user' ? 'user' : 'assistant'));
  wrap.dataset.index = String(index);

  if (msg.role === 'user') {
    const bubble = el('div', 'bubble');
    if (msg.images && msg.images.length) {
      const gallery = el('div', 'gallery');
      for (const img of msg.images) {
        const im = el('img', 'thumb');
        im.src = img.dataUrl;
        im.alt = img.name || '图片';
        gallery.appendChild(im);
      }
      bubble.appendChild(gallery);
    }
    if (msg.content) {
      const body = el('div', 'bubble-text md');
      body.innerHTML = renderMarkdown(msg.content);
      bubble.appendChild(body);
    }
    wrap.appendChild(bubble);
    appendVariants(wrap, session, msg, variantInfo);
    bindLongPress(wrap, () => openMessageMenu(msg, index, session));
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMessageMenu(msg, index, session);
    });
    return wrap;
  }

  const blocks = Array.isArray(msg.blocks) ? msg.blocks.filter(Boolean) : [];
  const thinkItems = blocks.filter(
    (b) => b.type === 'thinking' || b.type === 'search' || b.type === 'open'
  );
  const textItems = blocks.filter((b) => b.type === 'text');
  const content = textItems.length
    ? textItems.map((b) => b.text).join('')
    : (msg.content || '');
  const citations = textItems.reduce((acc, b) => acc.concat(b.citations || []), []);

  if (thinkItems.length || msg.reasoning) {
    const details = el('details', 'think');
    // 默认展开；用户手动收起后本次不会被重建打断
    details.open = msg.reasoningCollapsed !== true;
    details.addEventListener('toggle', () => {
      if (!details.open) msg.reasoningCollapsed = true;
      else delete msg.reasoningCollapsed;
    });
    const summary = el('summary', 'think-head');
    summary.textContent = msg.pending && !content
      ? '正在深度思考…'
      : `已思考（用时 ${msg.elapsedSecs || 1} 秒）`;
    details.appendChild(summary);

    const body = el('div', 'think-body md');
    if (thinkItems.length) renderTimeline(body, thinkItems);
    else body.innerHTML = renderMarkdown(msg.reasoning);
    details.appendChild(body);
    wrap.appendChild(details);
  }

  if (msg.pending && !content) {
    const loading = el('div', 'loading');
    loading.innerHTML = '<span></span><span></span><span></span>';
    wrap.appendChild(loading);
  } else {
    const body = el('div', 'md');
    body.innerHTML = renderMarkdown(content);
    wrap.appendChild(body);
  }

  if (msg.error) {
    const err = el('div', 'msg-error', msg.error);
    wrap.appendChild(err);
  }

  if (citations.length) {
    const sources = el('div', 'sources');
    sources.appendChild(el('div', 'sources-title', '来源'));
    citations.forEach((c, i) => {
      const a = el('a', 'source-item');
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${i + 1}. ${c.title || siteHost(c.url)}`;
      sources.appendChild(a);
    });
    wrap.appendChild(sources);
  }

  const actions = el('div', 'msg-actions');
  const copyBtn = el('button', 'act', '复制');
  copyBtn.addEventListener('click', () => copyText(content));
  actions.appendChild(copyBtn);

  if (!msg.pending) {
    const regen = el('button', 'act', '重新生成');
    regen.addEventListener('click', () => regenerate(session, index));
    actions.appendChild(regen);

    if (msg.status === 'stopped' || msg.stopReason === 'max_tokens') {
      const cont = el('button', 'act', '继续生成');
      cont.addEventListener('click', () => continueReply(session, index));
      actions.appendChild(cont);
    }
  }
  wrap.appendChild(actions);
  appendVariants(wrap, session, msg, variantInfo);

  bindLongPress(wrap, () => openMessageMenu(msg, index, session));
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMessageMenu(msg, index, session);
  });
  return wrap;
}

function renderMessages() {
  const session = currentSession();
  if (!session) return;
  dom.messages.innerHTML = '';

  const path = currentPath(session);
  for (const msg of path) {
    const members = siblingsOf(session, msg);
    const index = session.messages.indexOf(msg);
    const siblingIndex = members.findIndex((m) => m.id === msg.id);
    dom.messages.appendChild(
      messageNode(msg, index, session, { members, index: siblingIndex })
    );
  }
}

function openMessageMenu(msg, index, session) {
  const items = [
    { label: '复制', icon: 'copy', run: () => copyText(msg.content || '') },
  ];
  if (msg.role === 'user') {
    items.push({
      label: '编辑并重发',
      icon: 'pencil',
      run: () => editMessage(session, index),
    });
  } else if (!msg.pending) {
    items.push({
      label: '重新生成',
      icon: 'refresh',
      run: () => regenerate(session, index),
    });
  }
  items.push({
    label: '删除这条',
    icon: 'trash',
    danger: true,
    run: async () => {
      // 树形结构：连带删掉它的所有后代，别把别的分支也带走
      const doomed = new Set([msg.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of session.messages) {
          if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
            doomed.add(node.id);
            grew = true;
          }
        }
      }
      session.messages = session.messages.filter((node) => !doomed.has(node.id));
      touchSession(session);
      await persist(session);
      renderAll();
    },
  });
  openSheet(items);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制');
    } catch {
      toast('复制失败');
    }
    document.body.removeChild(ta);
  }
}

/* ------------------------------ 气泡菜单 ------------------------------ */

function openSheet(items) {
  const sheet = document.getElementById('sheet');
  const panel = document.getElementById('sheetPanel');
  if (!sheet || !panel) {
    alert('页面里找不到 #sheet，可能是浏览器缓存了旧版 index.html');
    return;
  }
  panel.innerHTML = '';
  for (const item of items) {
    const btn = el('button', 'sheet-item' + (item.danger ? ' danger' : ''), item.label);
    btn.addEventListener('click', () => {
      closeSheet();
      item.run();
    });
    panel.appendChild(btn);
  }
  const cancel = el('button', 'sheet-item cancel', '取消');
  cancel.addEventListener('click', closeSheet);
  panel.appendChild(cancel);
  sheet.hidden = false;
  sheet.style.display = 'flex';
  sheet.style.opacity = '1';
}

function closeSheet() {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  sheet.style.opacity = '0';
  setTimeout(() => {
    sheet.hidden = true;
    sheet.style.display = 'none';
  }, 160);
}

function bindLongPress(node, handler) {
  let timer = null;
  let fired = false;
  let startX = 0;
  let startY = 0;

  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      fired = true;
      handler();
    }, 480);
  });

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  node.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
  });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('click', (e) => {
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    }
  });
}

/* ------------------------------ 发送 ------------------------------ */

function updateSendButton() {
  const hasText = dom.input.value.trim().length > 0 || state.draftImages.length > 0;
  dom.btnSend.disabled = !hasText;
  dom.btnSend.classList.toggle('disabled', !hasText);
  dom.btnSend.hidden = state.streaming;
  dom.btnAttach.hidden = state.streaming;
  dom.btnStop.hidden = !state.streaming;
}

function autoGrow() {
  dom.input.style.height = 'auto';
  dom.input.style.height = Math.min(dom.input.scrollHeight, 140) + 'px';
}

function scrollToBottom(force) {
  const box = dom.chat;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function updateScrollButton() {
  const box = dom.chat;
  const away = box.scrollHeight - box.scrollTop - box.clientHeight > 300;
  dom.btnScrollBottom.hidden = !away;
}

function newSession() {
  const session = {
    id: db.newId(),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    messages: [],
  };
  state.sessions.unshift(session);
  state.currentId = session.id;
  state.draftImages = [];
  renderAll();
  dom.input.focus();
  return session;
}

async function send() {
  const text = dom.input.value.trim();
  if ((!text && !state.draftImages.length) || state.streaming) return;
  if (!state.settings.apiKey) {
    openSettings();
    toast('先填写 API Key');
    return;
  }

  let session = currentSession();
  if (!session) session = newSession();

  const images = state.draftImages.slice();
  state.draftImages = [];
  dom.input.value = '';
  autoGrow();

  const assistantOf = (userMsg) => ({
    id: db.newId(),
    role: 'assistant',
    parentId: userMsg.id,
    content: '',
    reasoning: '',
    blocks: [],
    citations: [],
    thinking: !!state.settings.think,
    search: !!state.settings.search,
    pending: true,
    startedAt: Date.now(),
    ts: Date.now(),
  });

  // 编辑后重发：新问题挂在同一个父节点下，成为兄弟分支，后续对话各走各的
  const editFrom = state.editFrom;
  state.editFrom = null;
  if (editFrom && editFrom.sessionId === session.id) {
    const old = session.messages.find((m) => m.id === editFrom.messageId);
    if (old && old.role === 'user') {
      const newUser = {
        id: db.newId(),
        role: 'user',
        parentId: old.parentId || null,
        content: text,
        images,
        ts: Date.now(),
      };
      const newAssistant = assistantOf(newUser);
      session.messages.push(newUser, newAssistant);
      if (!session.choice) session.choice = {};
      session.choice[parentKeyOf(newUser)] = newUser.id;

      touchSession(session);
      persist(session);
      renderAll();
      await runCompletion(session, newAssistant);
      return;
    }
  }

  const path = currentPath(session);
  const tail = path.length ? path[path.length - 1] : null;

  const userMsg = {
    id: db.newId(),
    role: 'user',
    parentId: tail ? tail.id : null,
    content: text,
    images,
    ts: Date.now(),
  };

  const assistantMsg = assistantOf(userMsg);

  session.messages.push(userMsg, assistantMsg);
  if (!session.choice) session.choice = {};
  session.choice[parentKeyOf(userMsg)] = userMsg.id;
  session.choice[userMsg.id] = assistantMsg.id;
  if (!session.title) session.title = text.slice(0, 24) || '图片对话';
  touchSession(session);
  persist(session);
  renderAll();

  await runCompletion(session, assistantMsg);
}

async function runCompletion(session, assistantMsg) {
  state.streaming = true;
  state.controller = new AbortController();
  updateSendButton();

  const history = currentPath(session)
    .filter((m) => m !== assistantMsg)
    .map((m) => ({ role: m.role, content: m.content, images: m.images }));

  // 按服务端内容块的下标存放：thinking / search / open / text，渲染时按顺序还原
  const blocks = [];
  const syncText = () => {
    assistantMsg.content = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    assistantMsg.reasoning = blocks
      .filter((b) => b && b.type === 'thinking')
      .map((b) => b.text)
      .join('');
    assistantMsg.blocks = blocks;
  };

  const paint = () => {
    const idx = session.messages.indexOf(assistantMsg);
    if (idx < 0) return;
    // 每次都按索引重新取当前节点，不缓存引用：避免节点被重建后引用失效而追加出重复消息
    const existing = dom.messages.children[idx];
    const node = messageNode(assistantMsg, idx, session);
    if (existing && existing.parentNode === dom.messages) {
      dom.messages.replaceChild(node, existing);
    } else {
      dom.messages.appendChild(node);
    }
    scrollToBottom();
  };

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  try {
    await streamMessage({
      apiKey: state.settings.apiKey,
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
      history,
      systemPrompt: composeSystemPrompt(),
      thinking: state.settings.think,
      search: state.settings.search,
      temperature: state.settings.temperature,
      wantTitle: !session.title || session.title.length === 0,
      signal: state.controller.signal,

      onBlockStart: (index, block) => {
        if (block.type === 'thinking') {
          blocks[index] = { type: 'thinking', text: '' };
        } else if (block.type === 'text') {
          blocks[index] = { type: 'text', text: '', citations: [] };
        } else if (block.type === 'server_tool_use') {
          blocks[index] = { type: 'tool', action: (block.input && block.input.action) || '' };
        } else if (block.type === 'web_search_tool_result') {
          const list = Array.isArray(block.content) ? block.content : [];
          blocks[index] = {
            type: 'search',
            sources: list
              .filter((item) => item && item.type === 'web_search_result')
              .map((item) => ({ url: item.url, title: item.title })),
          };
        } else if (block.type === 'web_fetch_tool_result') {
          const contentBlock = block.content || {};
          blocks[index] = {
            type: 'open',
            url: contentBlock.url || '',
            title: (contentBlock.content && contentBlock.content.title) || '',
          };
        }
        assistantMsg.blocks = blocks;
        syncText();
        schedule();
      },

      onBlockDelta: (index, delta) => {
        const target = blocks[index];
        if (!target) return;
        if (delta.type === 'thinking_delta') {
          target.text += delta.thinking || '';
        } else if (delta.type === 'text_delta') {
          target.text += delta.text || '';
        } else if (delta.type === 'citations_delta' && delta.citation) {
          if (target.type === 'text') {
            target.citations.push({ url: delta.citation.url, title: delta.citation.title || '' });
          }
        }
        syncText();
        schedule();
      },

      onStop: (reason) => {
        assistantMsg.stopReason = reason;
      },

      onTitle: (title) => {
        if (title && title.trim() && session.messages.filter((m) => m.role === 'user').length <= 1) {
          session.title = title.trim();
          dom.topTitle.textContent = session.title;
          renderSidebar();
        }
      },
    });
    assistantMsg.pending = false;
    assistantMsg.status = 'done';
    if (assistantMsg.reasoning) {
      assistantMsg.elapsedSecs = Math.max(1, Math.round((Date.now() - assistantMsg.startedAt) / 1000));
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      assistantMsg.status = 'stopped';
      assistantMsg.pending = false;
      if (!assistantMsg.content && !assistantMsg.reasoning) {
        assistantMsg.error = '已停止';
      }
    } else {
      assistantMsg.pending = false;
      assistantMsg.status = 'error';
      assistantMsg.error = err instanceof ApiError ? err.message : String(err && err.message || err);
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    assistantMsg.pending = false;
    assistantMsg.endedAt = Date.now();
    if (assistantMsg.reasoning && !assistantMsg.elapsedSecs) {
      assistantMsg.elapsedSecs = Math.max(1, Math.round((assistantMsg.endedAt - assistantMsg.startedAt) / 1000));
    }
    session.updatedAt = Date.now();
    persist(session);
    renderMessages();
    renderSidebar();
    updateSendButton();
    scrollToBottom(true);
  }
}

async function regenerate(session, index) {
  if (state.streaming) return;
  const old = session.messages[index];
  if (!old || old.role !== 'assistant') return;

  // 新回答挂在同一个父节点下，成为兄弟版本；切换时后续对话跟着走
  const assistantMsg = {
    id: db.newId(),
    role: 'assistant',
    parentId: old.parentId,
    content: '',
    reasoning: '',
    blocks: [],
    citations: [],
    thinking: !!state.settings.think,
    search: !!state.settings.search,
    pending: true,
    startedAt: Date.now(),
    ts: Date.now(),
  };

  session.messages.push(assistantMsg);
  if (!session.choice) session.choice = {};
  session.choice[parentKeyOf(assistantMsg)] = assistantMsg.id;

  touchSession(session);
  persist(session);
  renderAll();
  await runCompletion(session, assistantMsg);
}

/** 继续生成：把已有的部分回答作为 assistant 前缀发出去，只追加新增内容 */
async function continueReply(session, index) {
  const msg = session.messages[index];
  if (!msg || msg.role !== 'assistant' || state.streaming) return;
  if (msg.search) {
    toast('带联网搜索的回答不支持续写');
    return;
  }
  if (!msg.content) {
    toast('这条回答还没有内容');
    return;
  }

  const history = session.messages.slice(0, index + 1)
    .map((m) => ({ role: m.role, content: m.content, images: m.images }));

  const baseContent = msg.content;
  const baseReasoning = msg.reasoning || '';
  const newBlocks = [];

  state.streaming = true;
  state.controller = new AbortController();
  updateSendButton();

  let frame = 0;
  const paint = () => {
    const idx = session.messages.indexOf(msg);
    if (idx < 0) return;
    const existing = dom.messages.children[idx];
    const node = messageNode(msg, idx, session);
    if (existing && existing.parentNode === dom.messages) {
      dom.messages.replaceChild(node, existing);
    } else {
      dom.messages.appendChild(node);
    }
    scrollToBottom();
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };
  const refresh = () => {
    msg.content = baseContent + newBlocks
      .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    msg.reasoning = baseReasoning + newBlocks
      .filter((b) => b && b.type === 'thinking').map((b) => b.text).join('');
  };

  try {
    await streamMessage({
      apiKey: state.settings.apiKey,
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
      history,
      systemPrompt: composeSystemPrompt(),
      thinking: !!msg.thinking,
      search: false,
      temperature: state.settings.temperature,
      wantTitle: false,
      signal: state.controller.signal,
      onBlockStart: (i, block) => {
        if (block.type === 'text') newBlocks[i] = { type: 'text', text: '' };
        else if (block.type === 'thinking') newBlocks[i] = { type: 'thinking', text: '' };
        refresh();
        schedule();
      },
      onBlockDelta: (i, delta) => {
        const target = newBlocks[i];
        if (!target) return;
        if (delta.type === 'text_delta') target.text += delta.text || '';
        else if (delta.type === 'thinking_delta') target.text += delta.thinking || '';
        refresh();
        schedule();
      },
      onStop: (reason) => {
        msg.stopReason = reason;
      },
    });
    msg.status = 'done';
    if (msg.stopReason !== 'max_tokens') msg.stopReason = null;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      msg.status = 'stopped';
    } else {
      msg.error = err instanceof ApiError ? err.message : String((err && err.message) || err);
    }
  } finally {
    state.streaming = false;
    state.controller = null;
    refresh();
    msg.pending = false;
    session.updatedAt = Date.now();
    persist(session);
    renderMessages();
    updateSendButton();
    scrollToBottom(true);
  }
}

function editMessage(session, index) {
  const msg = session.messages[index];
  if (!msg || msg.role !== 'user' || state.streaming) return;
  dom.input.value = msg.content || '';
  state.draftImages = (msg.images || []).slice();
  // 发送时从这里截断，等同「改完重问」
  state.editFrom = { sessionId: session.id, messageId: msg.id };
  autoGrow();
  updateSendButton();
  dom.input.focus();
}

/* ------------------------------ 附件 ------------------------------ */

const MAX_IMAGE_EDGE = 1600;

async function readImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片格式不受支持'));
    image.src = dataUrl;
  });

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const compressed = canvas.toDataURL('image/jpeg', 0.85);

  return {
    id: db.newId(),
    name: file.name || 'image.jpg',
    size: Math.round((compressed.length * 3) / 4),
    dataUrl: compressed,
    width: canvas.width,
    height: canvas.height,
  };
}

async function addImages(files) {
  const list = Array.from(files).slice(0, 6);
  for (const file of list) {
    if (!file.type.startsWith('image/')) {
      toast('只支持图片');
      continue;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast('图片太大了（超过 20MB）');
      continue;
    }
    try {
      state.draftImages.push(await readImage(file));
    } catch (err) {
      toast(err.message || '图片读取失败');
    }
  }
  renderDraft();
  updateSendButton();
}

function renderDraft() {
  let bar = dom.composer.querySelector('.draft-bar');
  if (!state.draftImages.length) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = el('div', 'draft-bar');
    dom.composer.insertBefore(bar, dom.composer.firstChild);
  }
  bar.innerHTML = '';
  state.draftImages.forEach((img, i) => {
    const cell = el('div', 'draft-cell');
    const thumb = el('img');
    thumb.src = img.dataUrl;
    cell.appendChild(thumb);
    const del = el('button', 'draft-del', '×');
    del.addEventListener('click', () => {
      state.draftImages.splice(i, 1);
      renderDraft();
      updateSendButton();
    });
    cell.appendChild(del);
    bar.appendChild(cell);
  });
}

/* ------------------------------ 设置 ------------------------------ */

function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) {
    alert('页面里找不到 #settingsModal，可能是浏览器缓存了旧版 index.html');
    return;
  }
  try {
    const setValue = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.value = value;
    };
    setValue('setKey', state.settings.apiKey || '');
    setValue('setBase', state.settings.baseUrl || DEFAULT_BASE_URL);
    setValue('setModel', state.settings.model || DEFAULT_MODEL);
    setValue('setSystem', state.settings.systemPrompt || '');
    setValue('setTheme', state.settings.theme || 'auto');
    const temp = Number(state.settings.temperature);
    const tempInput = document.getElementById('setTemp');
    if (tempInput) {
      tempInput.value = String(Number.isFinite(temp) ? temp : 1);
      const label = document.getElementById('tempValue');
      if (label) label.textContent = Number(tempInput.value).toFixed(1);
    }
  } catch (err) {
    console.error('填充设置失败', err);
  }
  modal.hidden = false;
  modal.style.display = 'flex';
  modal.style.opacity = '1';
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.style.opacity = '0';
  setTimeout(() => {
    modal.hidden = true;
    modal.style.display = 'none';
  }, 160);
}

async function saveSettingsFromForm() {
  const key = $('setKey').value.trim();
  const base = $('setBase').value.trim() || DEFAULT_BASE_URL;
  const model = $('setModel').value.trim() || DEFAULT_MODEL;

  state.settings = Object.assign({}, state.settings, {
    apiKey: key,
    baseUrl: base,
    model,
    systemPrompt: $('setSystem').value,
    theme: $('setTheme').value,
    temperature: Number($('setTemp').value),
  });
  saveSettings();
  applyTheme();
  closeSettings();

  if (key) {
    toast('正在校验 Key…');
    try {
      const models = await verifyKey(key, base);
      toast(`Key 可用${models.length ? '，模型：' + models.join(' / ') : ''}`);
    } catch (err) {
      toast(err.message || 'Key 校验失败', 4000);
    }
  }
}

/* ------------------------------ 导入导出 ------------------------------ */

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

async function doExport() {
  if (!state.sessions.length) {
    toast('还没有对话可以导出');
    return;
  }
  try {
    const { blob, name } = exportArchive(
      state.sessions.map((s) => Object.assign({}, s, { messages: currentPath(s) }))
    );
    download(blob, name);
    toast('已导出，文件在「下载」里');
  } catch (err) {
    toast('导出失败：' + (err.message || err));
  }
}

async function doImport(file) {
  try {
    toast('正在解析…');
    const imported = await importArchive(file);
    let added = 0;
    let merged = 0;
    for (const session of imported) {
      const existing = state.sessions.find((s) => s.id === session.id);
      if (existing) {
        if (session.updatedAt > existing.updatedAt) {
          Object.assign(existing, session);
          merged += 1;
        }
      } else {
        state.sessions.push(session);
        added += 1;
      }
    }
    state.sessions.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    for (const s of imported) await db.putSession(s).catch(() => {});
    state.currentId = null;
    renderAll();
    toast(`导入完成：新增 ${added}，更新 ${merged}`);
  } catch (err) {
    toast('导入失败：' + (err.message || err), 5000);
  }
}

/* ------------------------------ 事件 ------------------------------ */

function bindEvents() {
  dom.btnMenu.addEventListener('click', () => {
    dom.sidebar.classList.add('open');
    dom.scrim.classList.add('open');
    dom.sidebar.setAttribute('aria-hidden', 'false');
  });
  dom.scrim.addEventListener('click', closeSidebar);

  dom.btnNew.addEventListener('click', () => {
    state.currentId = null;
    state.draftImages = [];
    dom.input.value = '';
    autoGrow();
    renderAll();
    dom.input.focus();
  });

  dom.input.addEventListener('input', () => {
    autoGrow();
    updateSendButton();
  });

  dom.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  });

  dom.btnSend.addEventListener('click', send);
  dom.btnStop.addEventListener('click', () => {
    if (state.controller) state.controller.abort();
  });

  dom.btnThink.addEventListener('click', () => {
    state.settings.think = !state.settings.think;
    saveSettings();
    renderAll();
  });
  dom.btnSearch.addEventListener('click', () => {
    state.settings.search = !state.settings.search;
    saveSettings();
    renderAll();
    if (state.settings.search) toast('已开启联网搜索，回答可能更慢');
  });

  dom.btnAttach.addEventListener('click', () => {
    openSheet([
      { label: '拍照', run: () => triggerFile('camera') },
      { label: '相册', run: () => triggerFile('gallery') },
      { label: '文件（暂不支持）', run: () => toast('当前只支持图片') },
    ]);
  });

  dom.btnSettings.addEventListener('click', openSettings);
  $('btnSettingsTop').addEventListener('click', openSettings);
  $('setTemp').addEventListener('input', (e) => {
    $('tempValue').textContent = Number(e.target.value).toFixed(1);
  });
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnSaveSettings').addEventListener('click', saveSettingsFromForm);
  $('btnExport').addEventListener('click', doExport);
  $('btnImport').addEventListener('click', () => dom.archiveInput.click());
  $('btnClear').addEventListener('click', async () => {
    if (!window.confirm('清空全部对话？此操作不可恢复。')) return;
    await db.clearSessions().catch(() => {});
    state.sessions = [];
    state.currentId = null;
    renderAll();
    closeSettings();
    toast('已清空');
  });

  dom.archiveInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) doImport(file);
    e.target.value = '';
  });

  dom.search.addEventListener('input', () => {
    state.query = dom.search.value;
    renderSidebar();
  });

  dom.btnScrollBottom.addEventListener('click', () => scrollToBottom(true));
  dom.chat.addEventListener('scroll', updateScrollButton, { passive: true });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

let pendingFileTarget = 'gallery';
function triggerFile(target) {
  pendingFileTarget = target;
  dom.imageInput.accept = 'image/*';
  dom.imageInput.removeAttribute('multiple');
  if (target === 'camera') dom.imageInput.setAttribute('capture', 'environment');
  else dom.imageInput.removeAttribute('capture');
  dom.imageInput.click();
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.scrim.classList.remove('open');
  dom.sidebar.setAttribute('aria-hidden', 'true');
}

/* ------------------------------ 启动 ------------------------------ */

function bindViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    // 键盘弹起时让整个应用跟随可视区域收缩，并用 offsetTop 抵消页面整体上移
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    document.documentElement.style.setProperty('--vvy', vv.offsetTop + 'px');
    const keyboardOpen = vv.height < window.innerHeight - 120;
    document.documentElement.classList.toggle('kb-open', keyboardOpen);
    if (document.activeElement === dom.input) scrollToBottom(true);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();

  // 兜底：部分 iOS 版本只有 focus 之后才更新 visualViewport
  dom.input.addEventListener('focus', () => setTimeout(apply, 120));
  dom.input.addEventListener('blur', () => setTimeout(apply, 120));
}

async function init() {
  // 把运行时错误显示出来，方便定位（控制台也能看到）
  window.addEventListener('error', (e) => {
    toast('脚本错误：' + (e.message || '未知'), 6000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    toast('未处理的异常：' + (reason && reason.message ? reason.message : String(reason)), 6000);
  });

  applyTheme();
  bindEvents();
  bindViewport();
  autoGrow();

  try {
    state.sessions = await db.listSessions();
    migrateSessions(state.sessions);
  } catch {
    state.sessions = [];
    toast('本地存储不可用，数据不会被保存');
  }

  dom.imageInput.accept = 'image/*';
  dom.imageInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await addImages(files);
    e.target.value = '';
  });

  renderAll();

  if (!state.settings.apiKey) {
    setTimeout(() => openSettings(), 400);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 调试开关：开启后会把流式响应里的工具调用、引用等字段打到控制台
  window.__dsDebug = true;

  // 调试钩子：Console 里可以直接检查元素和手动触发
  window.__ds = { state, dom, openSettings, closeSettings, send };
  window.__dsCheck = () =>
    Object.keys(dom).filter((k) => !dom[k]).concat(['all-ok']);
}

init();

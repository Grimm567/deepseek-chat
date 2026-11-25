import { renderMarkdown, renderBlocks } from './markdown.js';
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
  composerGap: 0,
  autoScroll: true,
  // 一轮回答结束后是否强制滚到底（与「流式期间是否跟随」分开控制）
  autoScrollEnd: true,
  msgScale: 1,
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
  draftImages: [],
  // 还没落库的新对话草稿（切走再切回来要能恢复）
  newDraft: null,
  query: '',
  selectMode: false,
  selected: new Set(),
  // 就地编辑：正在编辑的消息 id、编辑框里的文字和图片
  editingId: null,
  editingText: '',
  editingImages: [],
  // txt 附件：待发（草稿）和编辑框里的
  draftFiles: [],
  editingFiles: [],
};

// 每个会话各自一条生成流：切到别的会话时旧会话继续生成，新会话也能直接发消息。
// sessionId -> { controller, msgId }
const streams = new Map();

/** 指定会话（默认当前会话）是否正在生成 */
function isStreaming(sessionId = state.currentId) {
  return !!sessionId && streams.has(sessionId);
}

/** 中断某个会话的流（幂等） */
function stopStream(sessionId) {
  const entry = sessionId ? streams.get(sessionId) : null;
  if (!entry) return;
  try { entry.controller.abort(); } catch { /* 忽略 */ }
}

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
  btnNewSidebar: $('btnNewSidebar'),
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
  txtInput: $('txtInput'),
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

  // 自动插入的输出约定：只出现在发给模型的系统提示里，不会写进设置里的「系统提示词」输入框，
  // 并且排在用户自定义提示词之前。
  parts.push(
    '回答使用 Markdown。界面支持以下语法，请按需使用：\n'
    + '- 代码、配置、数据、日志、纯文本等需要单独呈现的内容，用带语言标签的代码块输出'
    + '（例如 ```python、```json、```txt、```bash），界面会按语言显示并带一键复制；\n'
    + '- 强调分三档：**普通加粗**、***小标题***、****大标题****；\n'
    + '- 数学公式用 $...$（行内）或 $$...$$（块级，独立成段）；\n'
    + '- 脚注用 [^1] 引用，并在文末用 [^1]: 内容 定义；\n'
    + '- 裸链接和邮箱会自动识别，不必额外加格式。'
  );

  const custom = (state.settings.systemPrompt || '').trim();
  if (custom) parts.push(custom);

  parts.push(`当前时间：${currentTimeText()}。涉及"今天""最近""现在"这类表述时以此为准。`);
  parts.push('历史消息开头方括号里是发送时间（月-日 时:分，本地时区），可用于理解「今天」「昨天」这类相对时间。');

  if (state.settings.search) {
    parts.push(
      '你已开启联网能力：可用 deepseek_web_search 搜索网页、用 deepseek_read_url 阅读用户给出的链接。'
      + '遇到需要最新信息、实时数据或你不确定的事实时，主动检索并在回答里给出引用来源。'
    );
  } else {
    parts.push('本次对话没有联网工具，遇到需要实时信息的问题，说明你的知识截止时间再作答。');
  }

  return parts.join('\n\n');
}

function applyTheme() {  const pref = state.settings.theme;
  const dark = pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#121317' : '#ffffff');
}

/** 输入框底边与键盘/屏幕底部的间距（用户可在设置里微调） */
function applyComposerGap() {
  const gap = Number(state.settings.composerGap);
  document.documentElement.style.setProperty(
    '--composer-gap',
    (Number.isFinite(gap) ? Math.max(0, gap) : 0) + 'px'
  );
}

/** 对话内容的字号缩放 */
function applyMsgScale() {
  const value = Number(state.settings.msgScale);
  const scale = Number.isFinite(value) && value > 0 ? Math.min(1.5, Math.max(0.85, value)) : 1;
  document.documentElement.style.setProperty('--msg-scale', String(scale));
}

/* ------------------------------ 设备类型 ------------------------------ */

// 判定“手机”看输入方式和视口，而不是只信 UA：触屏笔记本 / iPad / 请求桌面站点都不会误伤。
const mqCoarse = window.matchMedia('(pointer: coarse)');
const mqHover = window.matchMedia('(hover: hover)');

const device = {
  phone: false,
  touch: false,
  ios: false,
  android: false,
  standalone: false,
};

function detectDevice() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const touch = mqCoarse.matches || navigator.maxTouchPoints > 0;
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  return {
    // 手机 = 触摸输入 + 没有 hover + 窄视口；平板/触屏笔记本走桌面分支
    phone: touch && !mqHover.matches && window.innerWidth < 900,
    touch,
    ios,
    android,
    standalone,
  };
}

/** 把设备信息写到 <html> 的 data 属性上，CSS 和 JS 都能直接用 */
function applyDeviceClass() {
  Object.assign(device, detectDevice());
  const root = document.documentElement;
  root.dataset.device = device.phone ? 'phone' : 'desktop';
  if (device.ios) root.dataset.platform = 'ios';
  else if (device.android) root.dataset.platform = 'android';
  else delete root.dataset.platform;
  if (device.standalone) root.dataset.standalone = 'true';
  else delete root.dataset.standalone;
}

function bindDeviceWatchers() {
  let timer = 0;
  const refresh = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; applyDeviceClass(); }, 200);
  };
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
  mqCoarse.addEventListener('change', refresh);
  mqHover.addEventListener('change', refresh);
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

/* ------------------------------ 草稿 ------------------------------ */

const draftTimers = new Map();

/** 立即把当前输入框内容与附件存进会话（切会话/关页面前调用） */
function saveDraftNow() {
  const session = currentSession();
  const text = dom.input.value;
  const images = state.draftImages.slice();
  const files = state.draftFiles.slice();
  const empty = !text.trim() && !images.length && !files.length;
  if (!session) {
    // 还没落库的新对话：先挂在内存里，切回来还能恢复
    state.newDraft = empty ? null : { text, images, files };
    return;
  }
  if (empty) delete session.draft;
  else session.draft = { text, images, files, at: Date.now() };
  persist(session);
}

/** 输入/附件变化时防抖保存，避免每敲一个字就写一次 IndexedDB */
function scheduleDraftSave() {
  const key = state.currentId || 'new';
  clearTimeout(draftTimers.get(key));
  draftTimers.set(key, setTimeout(() => {
    draftTimers.delete(key);
    saveDraftNow();
  }, 700));
}

/** 切换会话后把草稿装回输入框 */
function restoreDraft(session) {
  const draft = session ? session.draft : state.newDraft;
  state.draftImages = draft && Array.isArray(draft.images) ? draft.images.slice() : [];
  state.draftFiles = draft && Array.isArray(draft.files) ? draft.files.slice() : [];
  dom.input.value = draft && typeof draft.text === 'string' ? draft.text : '';
  inputTrackValue = dom.input.value;
  inputTrackAt = performance.now();
  autoGrow();
  renderDraft();
  updateSendButton();
}

/** 发送成功后清掉该会话的草稿 */
function clearDraft(session) {
  state.newDraft = null; // 新对话的临时草稿也一并作废
  if (!session || !session.draft) return;
  delete session.draft;
  persist(session);
}

/** 统一的会话切换入口：先存当前草稿，再加载目标会话的草稿 */
function openConversation(session) {
  const id = session ? session.id : null;
  if (id === state.currentId) {
    closeSidebar();
    return;
  }
  saveDraftNow();
  state.currentId = id;
  closeSidebar();
  renderAll();
  restoreDraft(session);
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
          openConversation(s);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openSessionMenu(s);
        });
        bindLongPress(row, () => openSessionMenu(s));
      }
      dom.convList.appendChild(row);

      // 搜索时把命中的消息片段也列出来，点一下直接跳到那条消息
      if (q && !state.selectMode) {
        const hits = (s.messages || [])
          .filter((m) => (m.content || '').toLowerCase().includes(q))
          .slice(0, 3);
        for (const hit of hits) {
          const item = el('button', 'conv-hit');
          item.type = 'button';
          item.appendChild(el('span', 'conv-hit-who', hit.role === 'user' ? '你' : 'AI'));
          item.appendChild(el('span', 'conv-hit-text', snippetAround(hit.content || '', q)));
          item.addEventListener('click', () => jumpToMessage(s, hit.id));
          dom.convList.appendChild(item);
        }
      }
    }
  }
}

/** 截取关键词附近的一小段，用于搜索结果预览 */
function snippetAround(text, q, radius = 24) {
  const plain = String(text).replace(/\s+/g, ' ').trim();
  const at = plain.toLowerCase().indexOf(q);
  if (at < 0) return plain.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(plain.length, at + q.length + radius);
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}

/** 跳到某条消息：打开会话后滚动定位并短暂高亮 */
function jumpToMessage(session, msgId) {
  openConversation(session);
  requestAnimationFrame(() => {
    const node = dom.messages.querySelector(`[data-id="${msgId}"]`);
    if (!node) {
      toast('这条消息不在当前分支里');
      return;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('msg-flash');
    setTimeout(() => node.classList.remove('msg-flash'), 1500);
  });
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
    // 正在生成的会话要先掐断，否则流式回调会把删掉的会话又写回数据库
    stopStream(id);
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
        stopStream(session.id); // 同上：先掐流，避免被写回
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
  else {
    dom.messages.innerHTML = '';
    renderMessageNav();
  }
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

/* --------------------------- 流式增量渲染 --------------------------- */

/** 一条消息实际展示的文本（优先 blocks 里的 text 块） */
function messageContentText(msg) {
  const blocks = Array.isArray(msg.blocks) ? msg.blocks.filter(Boolean) : [];
  const textItems = blocks.filter((b) => b.type === 'text');
  return textItems.length ? textItems.map((b) => b.text).join('') : (msg.content || '');
}

/** HTML 片段 → 块节点（渲染器的每个块恰好一个根元素） */
function blockNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.firstElementChild;
}

/**
 * 增量填充容器：与上次渲染相同的块保留原 DOM，只替换变化的部分。
 * 流式输出时每帧只有最后一块在变，前面的 KaTeX / 图片 / 代码块不再重建，
 * 顺带解决选区被重建打散、图片查看器点不中这些连带问题。
 */
function fillBlocks(container, src, pendingLabel) {
  const { blocks, pending } = renderBlocks(src);
  const prev = container.__sigs || [];
  let same = 0;
  while (same < blocks.length && same < prev.length && blocks[same] === prev[same]) same++;
  while (container.children.length > same) container.removeChild(container.lastChild);
  for (let i = same; i < blocks.length; i++) {
    const node = blockNode(blocks[i]);
    if (node) container.appendChild(node);
  }
  if (pending) container.appendChild(el('div', 'md-pending', pendingLabel || '代码生成中…'));
  container.__sigs = blocks;
}

/**
 * 流式期间就地更新已渲染的节点。返回 false 表示这块结构还没准备好（比如还在 loading
 * 占位、思考区还没建），调用方应退回全量重建。
 */
function updateStreamingNode(node, msg) {
  const content = messageContentText(msg);
  const blocks = Array.isArray(msg.blocks) ? msg.blocks.filter(Boolean) : [];
  const thinkItems = blocks.filter(
    (b) => b.type === 'thinking' || b.type === 'search' || b.type === 'open'
  );

  let body = null;
  let details = null;
  for (const child of node.children) {
    if (child.classList.contains('md')) body = child;
    else if (child.classList.contains('think')) details = child;
  }
  if (!body && content) return false;
  // 思考区还没建出来就必须全量重建：不管思考内容来自 blocks 里的 thinking 块
  // （新格式）还是 msg.reasoning 字段（旧格式），漏判任何一路都会让思考内容憋着不显示
  if (!details && (thinkItems.length || msg.reasoning)) return false;

  if (body) fillBlocks(body, content);

  if (details) {
    const summary = details.querySelector('.think-head');
    const thinkBody = details.querySelector('.think-body');
    if (summary) {
      summary.textContent = msg.pending && !content
        ? '正在深度思考…'
        : `已思考（用时 ${msg.elapsedSecs || 1} 秒）`;
    }
    if (thinkBody) {
      if (thinkItems.length) {
        // 有思考/搜索步骤：每帧重建整条时间线。
        // 之前为了省开销跳过它，结果思考内容要等正文出现才一次性冒出来 —— 那才是问题根源。
        thinkBody.innerHTML = '';
        renderTimeline(thinkBody, thinkItems);
      } else {
        fillBlocks(thinkBody, msg.reasoning || '');
      }
    }
  }
  return true;
}

function messageNode(msg, index, session, variantInfo) {
  if (state.editingId === msg.id) return messageEditorNode(msg, index, session);
  const wrap = el('div', 'msg ' + (msg.role === 'user' ? 'user' : 'assistant'));
  wrap.dataset.index = String(index);
  wrap.dataset.id = String(msg.id);

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
    if (msg.files && msg.files.length) {
      const filesWrap = el('div', 'msg-files');
      msg.files.forEach((file) => {
        filesWrap.appendChild(txtChip(file, {
          title: '双击插入到输入框',
          onOpen: () => insertTextAtFront(file.text, state.editingId ? 'editor' : 'draft'),
        }));
      });
      bubble.appendChild(filesWrap);
    }
    if (msg.content) {
      const body = el('div', 'bubble-text md');
      body.innerHTML = renderMarkdown(msg.content);
      bubble.appendChild(body);
    }
    wrap.appendChild(bubble);
    appendVariants(wrap, session, msg, variantInfo);
    wrap.appendChild(el('div', 'hover-zone'));
    wrap.appendChild(hoverActions(msg, index, session, msg.content || ''));
    bindLongPress(wrap, (x, y) => {
      if (document.documentElement.classList.contains('sel-mode')) return; // 框选中：不要再弹菜单
      openMessageMenu(msg, index, session, { x, y }, wrap);
    });
    return wrap;
  }

  const blocks = Array.isArray(msg.blocks) ? msg.blocks.filter(Boolean) : [];
  const thinkItems = blocks.filter(
    (b) => b.type === 'thinking' || b.type === 'search' || b.type === 'open'
  );
  const textItems = blocks.filter((b) => b.type === 'text');
  const content = messageContentText(msg);
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
    else fillBlocks(body, msg.reasoning || '');
    details.appendChild(body);
    wrap.appendChild(details);
  }

  if (msg.pending && !content) {
    const loading = el('div', 'loading');
    loading.innerHTML = '<span></span><span></span><span></span>';
    wrap.appendChild(loading);
  } else {
    const body = el('div', 'md');
    fillBlocks(body, content);
    wrap.appendChild(body);
  }

  if (msg.error) {
    const err = el('div', 'msg-error', msg.error);
    wrap.appendChild(err);
  }

  if (citations.length) {
    // 来源默认折叠，避免十条链接把对话拉得很长；用户手动展开后本次保持展开，
    // 流式期间节点会重建，所以状态记在 msg 上（和「已思考」同一套做法）。
    const sources = el('details', 'sources');
    sources.open = msg.sourcesOpen === true;
    sources.addEventListener('toggle', () => {
      if (sources.open) msg.sourcesOpen = true;
      else delete msg.sourcesOpen;
    });
    const sourceTitle = el('summary', 'sources-title');
    sourceTitle.textContent = `来源（${citations.length}）`;
    sources.appendChild(sourceTitle);
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
  wrap.appendChild(el('div', 'hover-zone'));
  wrap.appendChild(hoverActions(msg, index, session, content));

  // 生成中的回复不弹气泡菜单：流式期间节点每帧重建，长按 + iOS 手势会打架，
  // 菜单可能关不掉；删除 pending 消息也会让流式状态错乱。
  bindLongPress(wrap, (x, y) => {
    if (msg.pending) return;
    if (document.documentElement.classList.contains('sel-mode')) return; // 框选中：不要再弹菜单
    openMessageMenu(msg, index, session, { x, y }, wrap);
  });
  return wrap;
}

/* ------------------------------ 消息编辑 ------------------------------ */

const ICON_COPY = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2.2"></rect><path d="M5.5 14.5V6.2A1.7 1.7 0 0 1 7.2 4.5h8.3"></path></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.6-1.1L19 8.5a2.1 2.1 0 0 0-3-3L5.6 15.9 4 20z"></path><path d="M13.6 6.4l3 3"></path></svg>';
const ICON_REGEN = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4v5h-5"></path></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"></path><path d="M6.5 7l.8 12.2A1.6 1.6 0 0 0 8.9 20.7h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7"></path><path d="M10.2 11v5.5M13.8 11v5.5"></path></svg>';

/** 桌面端悬停菜单：用户消息 =「复制 / 修改」，助手消息 =「复制 / 重新生成」 */
function hoverActions(msg, index, session, text) {
  const bar = el('div', 'hover-actions');
  const copy = el('button', 'hact');
  copy.type = 'button';
  copy.title = '复制';
  copy.innerHTML = ICON_COPY;
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(text);
  });
  bar.appendChild(copy);

  if (msg.role === 'user') {
    const edit = el('button', 'hact');
    edit.type = 'button';
    edit.title = '修改';
    edit.innerHTML = ICON_EDIT;
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEdit(msg, index, session);
    });
    bar.appendChild(edit);
  } else {
    const regen = el('button', 'hact');
    regen.type = 'button';
    regen.title = '重新生成';
    regen.innerHTML = ICON_REGEN;
    regen.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerate(session, index);
    });
    bar.appendChild(regen);
  }

  // 桌面端取消了右键菜单，删除入口放在这里
  const del = el('button', 'hact');
  del.type = 'button';
  del.title = '删除';
  del.innerHTML = ICON_TRASH;
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMessage(msg, session);
  });
  bar.appendChild(del);
  return bar;
}

function clearEdit() {
  state.editingId = null;
  state.editingText = '';
  state.editingImages = [];
  state.editingFiles = [];
}

/** 光标放到编辑框末尾 */
function focusEditor() {
  const ta = document.querySelector('.msg-editor-text');
  if (!ta) return;
  ta.focus();
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
  autoGrowEditor(ta);
}

function autoGrowEditor(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

/** 就地编辑节点：消息位置变成一个带边框的编辑框 */
function messageEditorNode(msg, index, session) {
  const wrap = el('div', 'msg editing ' + (msg.role === 'user' ? 'user' : 'assistant'));
  wrap.dataset.index = String(index);
  wrap.dataset.id = String(msg.id);

  const box = el('div', 'msg-editor');

  if (state.editingImages.length) {
    const images = el('div', 'msg-editor-images');
    state.editingImages.forEach((img, i) => {
      const holder = el('div', 'msg-editor-image');
      const im = el('img');
      im.src = img.dataUrl;
      im.alt = img.name || '图片';
      const del = el('button', 'img-del', '×');
      del.title = '移除图片';
      del.addEventListener('click', () => {
        state.editingImages.splice(i, 1);
        renderMessages();
        focusEditor();
      });
      holder.appendChild(im);
      holder.appendChild(del);
      images.appendChild(holder);
    });
    box.appendChild(images);
  }

  if (state.editingFiles.length) {
    const filesWrap = el('div', 'msg-editor-images');
    state.editingFiles.forEach((file, i) => {
      filesWrap.appendChild(txtChip(file, {
        title: '双击插入到编辑框',
        onRemove: () => {
          state.editingFiles.splice(i, 1);
          renderMessages();
          focusEditor();
        },
        onOpen: () => {
          state.editingFiles.splice(i, 1);
          insertTextAtFront(file.text, 'editor');
        },
      }));
    });
    box.appendChild(filesWrap);
  }

  const ta = el('textarea', 'msg-editor-text');
  ta.value = state.editingText;
  ta.rows = 2;
  ta.placeholder = '修改内容…';
  ta.addEventListener('input', () => {
    state.editingText = ta.value;
    autoGrowEditor(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitEdit(session, index);
    }
  });
  box.appendChild(ta);

  const bar = el('div', 'msg-editor-bar');
  const attach = el('button', 'attach-btn', '图片');
  attach.title = '添加图片';
  attach.addEventListener('click', () => triggerFile('gallery'));
  const cancel = el('button', 'ghost-btn', '取消');
  cancel.addEventListener('click', cancelEdit);
  const sendBtn = el('button', 'primary-btn', '发送');
  sendBtn.addEventListener('click', () => submitEdit(session, index));
  bar.appendChild(attach);
  bar.appendChild(cancel);
  bar.appendChild(sendBtn);
  box.appendChild(bar);

  wrap.appendChild(box);
  return wrap;
}

function startEdit(msg, index, session) {
  if (isStreaming(session.id)) return;
  state.editingId = msg.id;
  state.editingText = msg.content || '';
  state.editingImages = (msg.images || []).map((img) => Object.assign({}, img));
  state.editingFiles = (msg.files || []).map((f) => Object.assign({}, f));
  renderMessages();
  focusEditor();
}

function cancelEdit() {
  if (!state.editingId) return;
  clearEdit();
  renderMessages();
}

/** 提交修改：用户消息作为新分支重发，助手消息生成新的版本 */
function submitEdit(session, index) {
  const msg = session.messages[index];
  if (!msg) return;
  const text = (state.editingText || '').trim();
  const images = state.editingImages.slice();
  const files = state.editingFiles.slice();

  if (msg.role === 'user') {
    if (!text && !images.length && !files.length) return;
    dom.input.value = text;
    state.draftImages = images;
    state.draftFiles = files;
    // 发送时从这里截断，等同「改完重问」
    state.editFrom = { sessionId: session.id, messageId: msg.id };
    clearEdit();
    autoGrow();
    updateSendButton();
    send();
    return;
  }

  if (!text) return;
  const next = {
    id: db.newId(),
    role: 'assistant',
    parentId: msg.parentId,
    content: text,
    reasoning: '',
    blocks: [],
    citations: [],
    thinking: !!msg.thinking,
    search: !!msg.search,
    pending: false,
    status: 'done',
    ts: Date.now(),
  };
  session.messages.push(next);
  if (!session.choice) session.choice = {};
  session.choice[parentKeyOf(msg)] = next.id;
  touchSession(session);
  persist(session);
  clearEdit();
  renderAll();
}

async function addImagesToEdit(files) {
  const list = Array.from(files).slice(0, 6);
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      state.editingImages.push(await readImage(file));
    } catch { /* 跳过坏图 */ }
  }
  renderMessages();
  focusEditor();
}

/**
 * 按消息 id 找当前已渲染的节点。
 * DOM 里只有当前分支路径的消息，而 session.messages 还包含别的分支，
 * 所以不能用「消息在数组里的下标」去索引 dom.messages.children，否则有分支后必然错位。
 */
function renderedNode(msg) {
  const id = String(msg.id);
  for (const node of dom.messages.children) {
    if (node.dataset && node.dataset.id === id) return node;
  }
  return null;
}

function renderMessages() {
  const session = currentSession();
  if (!session) {
    dom.messages.innerHTML = '';
    renderMessageNav();
    return;
  }
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
  renderMessageNav();
}

/* --------------------------- 消息导航（右侧刻度） --------------------------- */

let navEl = null;
let navPopEl = null;
let navTargets = [];   // [{ id, node, tick, item }]
let navHideTimer = 0;
let navLockUntil = 0;  // 点击跳转后短暂锁定，避免平滑滚动途中高亮乱跳

function ensureMessageNav() {
  if (navEl) return;
  navEl = el('div', 'msg-nav');
  navEl.innerHTML = '<div class="msg-nav-track"></div><div class="msg-nav-pop" hidden></div>';
  document.body.appendChild(navEl);
  navPopEl = navEl.querySelector('.msg-nav-pop');

  const show = () => {
    clearTimeout(navHideTimer);
    navPopEl.hidden = false;
  };
  const hideLater = () => {
    clearTimeout(navHideTimer);
    navHideTimer = setTimeout(() => { navPopEl.hidden = true; }, 180);
  };
  navEl.addEventListener('mouseenter', show);
  navEl.addEventListener('mouseleave', hideLater);
  // 菜单在刻度左侧，中间有一点空隙；进出都带延时，鼠标划过去不会闪
  navPopEl.addEventListener('mouseenter', show);
  navPopEl.addEventListener('mouseleave', hideLater);
}

/** 重建右侧消息刻度：每条用户提问一个刻度，hover 出二级列表 */
function renderMessageNav() {
  ensureMessageNav();
  const nodes = Array.from(dom.messages.querySelectorAll('.msg.user'));
  const track = navEl.querySelector('.msg-nav-track');
  track.innerHTML = '';
  navPopEl.innerHTML = '';
  navTargets = [];

  // 消息太少就不占右侧（一两个点的导航没有意义）
  if (nodes.length < 2) {
    navEl.classList.add('empty');
    return;
  }
  navEl.classList.remove('empty');
  navEl.style.setProperty('--nav-count', String(nodes.length));

  nodes.forEach((node) => {
    const text = Array.from(node.querySelectorAll('.bubble-text'))
      .map((n) => n.textContent.trim())
      .join(' ')
      .replace(/\s+/g, ' ');
    const label = text ? text.slice(0, 28) : '[附件]';

    const tick = el('button', 'msg-nav-tick');
    tick.type = 'button';
    tick.dataset.target = node.dataset.id;
    tick.addEventListener('click', () => jumpToMessageById(node.dataset.id));
    track.appendChild(tick);

    const item = el('button', 'msg-nav-item', label);
    item.type = 'button';
    item.dataset.target = node.dataset.id;
    item.addEventListener('click', () => jumpToMessageById(node.dataset.id));
    navPopEl.appendChild(item);

    navTargets.push({ id: node.dataset.id, node, tick, item });
  });

  syncNavActive();
}

/** 点击导航项：滚到那条消息并闪一下（和搜索结果跳转同一套表现） */
function jumpToMessageById(id) {
  const index = navTargets.findIndex((t) => t.id === id);
  const node = dom.messages.querySelector(`[data-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('msg-flash');
  setTimeout(() => node.classList.remove('msg-flash'), 1500);
  // 点了哪一条就立刻标哪一条，别等滚动计算追上
  if (index >= 0) syncNavActive(index);
}

function applyNavActive(index) {
  navTargets.forEach((t, i) => {
    const on = i === index;
    if (t.tick.classList.contains('active') !== on) t.tick.classList.toggle('active', on);
    if (t.item.classList.contains('active') !== on) t.item.classList.toggle('active', on);
  });
}

/** 滚动时点亮「离视口中心最近的那条提问」；forcedIndex 用于点击后立即锁定 */
function syncNavActive(forcedIndex) {
  if (!navEl || navEl.classList.contains('empty') || !navTargets.length) return;
  if (typeof forcedIndex === 'number') {
    applyNavActive(forcedIndex);
    navLockUntil = performance.now() + 600; // 平滑滚动期间别再抢
    return;
  }
  if (performance.now() < navLockUntil) return;
  const box = dom.chat;
  // 用视口中心比对消息中心：点击是把消息居中的，用「顶部过 35%」会一直慢一拍
  const viewMid = box.scrollTop + box.clientHeight / 2;
  let active = 0;
  let best = Infinity;
  navTargets.forEach((t, i) => {
    const center = t.node.offsetTop + t.node.offsetHeight / 2;
    const d = Math.abs(center - viewMid);
    if (d < best) {
      best = d;
      active = i;
    }
  });
  applyNavActive(active);
}

function openMessageMenu(msg, index, session, point, msgEl) {
  const items = [
    { label: '复制', icon: 'copy', run: () => copyText(msg.content || '') },
  ];
  // 手机端长按才有坐标：加「选择文本」，点了才进入框选
  if (point) {
    items.push({
      label: '选择文本',
      icon: 'select',
      run: () => startTextSelect(msgEl, point),
    });
  }
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
    run: () => deleteMessage(msg, session),
  });
  // 手机端贴着长按位置弹出；没有坐标（兜底路径）仍用底部弹层
  if (point) openFloatMenu(items, point);
  else openSheet(items);
}

/* ------------------------------ 浮动菜单 ------------------------------ */

let floatMenuEl = null;

function onFloatMenuOutside(e) {
  if (floatMenuEl && !floatMenuEl.contains(e.target)) closeFloatMenu();
}

function closeFloatMenu() {
  if (!floatMenuEl) return;
  floatMenuEl.remove();
  floatMenuEl = null;
  document.removeEventListener('pointerdown', onFloatMenuOutside, true);
}

/** 贴着长按位置弹出的菜单，超出屏幕会自动翻到另一侧 */
function openFloatMenu(items, point) {
  closeFloatMenu();
  const menu = el('div', 'float-menu');
  for (const item of items) {
    const btn = el('button', 'float-item' + (item.danger ? ' danger' : ''), item.label);
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeFloatMenu();
      item.run();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const gap = 10;
  let left = point.x + gap;
  let top = point.y + gap;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, point.x - rect.width - gap);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  floatMenuEl = menu;
  // 下一帧再挂外部点击，避免这次长按的残留事件立刻关掉菜单
  setTimeout(() => document.addEventListener('pointerdown', onFloatMenuOutside, true), 0);
}

/* ------------------------------ 选择文本 ------------------------------ */

/** 由 bindSelectionBar 赋值；进入/退出框选模式时要刷新那条工具条 */
let refreshSelectBar = () => {};

/** 取长按点所在的文本位置（兼容 WebKit 与标准两套 API） */
function caretRangeAt(point) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(point.x, point.y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(point.x, point.y);
    if (!pos || !pos.offsetNode) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/** 长按点所在的那句话：按句末标点切边界，作为「选择文本」的初始选区 */
function sentenceRangeAt(point, msgEl) {
  const caret = caretRangeAt(point);
  if (!caret) return null;
  if (msgEl && !msgEl.contains(caret.startContainer)) return null;
  let node = caret.startContainer;
  if (node.nodeType !== 3) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    node = walker.nextNode();
  }
  if (!node || node.nodeType !== 3) return null;
  const text = node.textContent || '';
  const offset = Math.min(caret.startOffset, text.length);
  const STOP = /[。！？!?；;\n]/; // 句末标点；整段没标点就选整段
  let start = offset;
  let end = offset;
  while (start > 0 && !STOP.test(text[start - 1])) start--;
  while (end < text.length && !STOP.test(text[end])) end++;
  if (end < text.length) end++; // 把句末标点也带上
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

/** 兜底选区：整条消息的内容（caret 定位失败时用） */
function rangeOfMessage(msgEl) {
  const body = msgEl.querySelector('.md, .bubble-text') || msgEl;
  const range = document.createRange();
  try {
    range.selectNodeContents(body);
  } catch {
    return null;
  }
  return range;
}

/** 进入框选模式：先自动选中长按处那句话，再把该消息放开为可选中，供手动拖手柄微调 */
function startTextSelect(msgEl, point) {
  if (!msgEl) return;
  document.documentElement.classList.add('sel-mode');
  msgEl.classList.add('select-mode');
  // 关键：先强制一次样式重算，让 user-select: text 真正生效，再建选区。
  // 否则 Safari 会忽略这次程序化选区 —— 表现就是点完「选择文本」没有选中高亮，
  // 非要滚动一下（触发重绘）之后才冒出来。
  void msgEl.offsetHeight;

  const apply = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) {
      refreshSelectBar(); // 已经有选区了（用户抢先一步），别覆盖
      return;
    }
    const range = sentenceRangeAt(point, msgEl) || rangeOfMessage(msgEl);
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    void msgEl.offsetHeight; // 再踢一次重绘，让高亮立刻画出来
    refreshSelectBar();
  };

  // 双保险：下一帧 + 稍后再各试一次，覆盖 iOS 上样式生效与选区建立先后顺序的差异
  requestAnimationFrame(apply);
  setTimeout(apply, 60);
}

/** 退出框选模式：恢复「长按弹菜单」的默认行为 */
function exitTextSelect() {
  document.documentElement.classList.remove('sel-mode');
  for (const node of document.querySelectorAll('.msg.select-mode')) node.classList.remove('select-mode');
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  refreshSelectBar();
}

/** 删除一条消息（含它的所有分支后代），供气泡菜单与框选工具条共用 */
async function deleteMessage(msg, session) {
  // 正在生成的回复：先把流式中止，避免删除后流式回调继续改状态
  if (msg.pending) stopStream(session ? session.id : null);
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
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('已复制');
      return true;
    }
  } catch { /* 用下面的兜底方案 */ }

  // iOS 对隐藏 textarea 的选中不友好，用 1px 可见区域 + readonly 提高成功率
  const ta = el('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.opacity = '0.01';
  ta.style.fontSize = '16px';
  ta.style.zIndex = '-1';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { ta.setSelectionRange(0, ta.value.length); } catch { /* 忽略 */ }
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  toast(ok ? '已复制' : '复制失败，请长按选中文本');
  return ok;
}

/* ------------------------------ 图片查看器 ------------------------------ */

let viewerList = [];
let viewerIndex = 0;
let viewerEl = null;

function ensureViewer() {
  if (viewerEl) return viewerEl;
  viewerEl = el('div', 'img-viewer');
  viewerEl.innerHTML = '<button class="img-viewer-close" aria-label="关闭">×</button>'
    + '<button class="img-viewer-nav img-viewer-prev" aria-label="上一张">‹</button>'
    + '<img class="img-viewer-img" alt="">'
    + '<button class="img-viewer-nav img-viewer-next" aria-label="下一张">›</button>';
  document.body.appendChild(viewerEl);
  viewerEl.addEventListener('click', (e) => {
    if (e.target === viewerEl || e.target.closest('.img-viewer-close')) closeImageViewer();
    else if (e.target.closest('.img-viewer-prev')) stepImageViewer(-1);
    else if (e.target.closest('.img-viewer-next')) stepImageViewer(1);
  });
  return viewerEl;
}

function updateImageViewer() {
  if (!viewerEl) return;
  const img = viewerEl.querySelector('.img-viewer-img');
  img.src = viewerList[viewerIndex] || '';
  const multi = viewerList.length > 1;
  viewerEl.querySelector('.img-viewer-prev').style.display = multi ? 'grid' : 'none';
  viewerEl.querySelector('.img-viewer-next').style.display = multi ? 'grid' : 'none';
}

function openImageViewer(list, index) {
  viewerList = (list || []).filter(Boolean);
  if (!viewerList.length) return;
  viewerIndex = Math.min(Math.max(0, index || 0), viewerList.length - 1);
  const v = ensureViewer();
  v.hidden = false;
  v.style.display = 'flex';
  updateImageViewer();
}

function stepImageViewer(delta) {
  if (viewerList.length < 2) return;
  viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
  updateImageViewer();
}

function closeImageViewer() {
  if (!viewerEl) return;
  viewerEl.hidden = true;
  viewerEl.style.display = 'none';
}

/* ------------------------------ 气泡菜单 ------------------------------ */

// 菜单刚弹出的一小段时间内不响应点击：长按触发时手指还没抬起，
// 抬起瞬间可能正好落在「复制」等按钮上造成误触。
let sheetArmedAt = 0;

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
      if (performance.now() < sheetArmedAt) return;
      closeSheet();
      item.run();
    });
    panel.appendChild(btn);
  }
  const cancel = el('button', 'sheet-item cancel', '取消');
  cancel.addEventListener('click', () => {
    if (performance.now() < sheetArmedAt) return;
    closeSheet();
  });
  panel.appendChild(cancel);
  sheetArmedAt = performance.now() + 350;
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

/** 当前是否有用户框选的文本。流式重建 DOM 会让选区错位甚至丢失，选中期间先不重绘。 */
function textSelectionActive() {
  const sel = window.getSelection();
  return !!(sel && sel.rangeCount > 0 && !sel.isCollapsed && String(sel).trim());
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
      // 把长按位置交给菜单：手机端菜单要贴着手指弹出，而不是从底部滑出
      handler(startX, startY);
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
  const hasText = dom.input.value.trim().length > 0 || state.draftImages.length > 0 || state.draftFiles.length > 0;
  dom.btnSend.disabled = !hasText;
  dom.btnSend.classList.toggle('disabled', !hasText);
  const busy = isStreaming();
  dom.btnSend.hidden = busy;
  dom.btnAttach.hidden = busy;
  dom.btnStop.hidden = !busy;
}

function autoGrow() {
  dom.input.style.height = 'auto';
  dom.input.style.height = Math.min(dom.input.scrollHeight, 140) + 'px';
}

// 自动跟随状态：用户主动上滑看历史就立刻停止，滑回底部恢复。
// 判定必须靠「手指/滚轮方向」加「程序滚动冷却」，不能只看 scrollTop 变小 ——
// 流式重渲染会让内容高度抖动、scrollTop 被浏览器 clamp，那样会被误判成上滑而彻底停摆。
let stickToBottom = true;
let lastScrollTop = 0;
let lastTouchY = 0;
let lastProgrammaticAt = 0;

function onChatScroll() {
  const box = dom.chat;
  const top = box.scrollTop;
  const distance = box.scrollHeight - top - box.clientHeight;
  const movedUp = top < lastScrollTop - 2;
  const movedDown = top > lastScrollTop + 1;
  if (movedUp && performance.now() - lastProgrammaticAt > 80) {
    // 用户主动上滑：立刻停止跟随。程序滚动后的 80ms 内不判，避免流式重排的抖动误伤
    stickToBottom = false;
  } else if (movedDown && distance <= 12) {
    // 只有「主动往下滚到底」才恢复跟随。原来只要距离底部 12px 内就恢复，
    // 结果轻微上滑几像素就被立刻拽回底部 —— 手机上表现为怎么滑都退不出自动跟随
    stickToBottom = true;
  }
  lastScrollTop = top;
  updateScrollButton();
  syncNavActive();
}

function scrollToBottom(force) {
  if (force) stickToBottom = true;
  // 关掉「自动滚动」设置时，除非明确要求，否则一概不自动动
  if (state.settings.autoScroll === false && !force) return;
  if (!stickToBottom) return;
  const box = dom.chat;
  box.scrollTop = box.scrollHeight;
  lastScrollTop = box.scrollTop;
  lastProgrammaticAt = performance.now();
}

/** 设置里的「自动跟随」生效：开启时立即滚到底 */
function applyFollowState() {
  if (state.settings.autoScroll !== false) scrollToBottom(true);
}

function updateScrollButton() {
  const box = dom.chat;
  const away = box.scrollHeight - box.scrollTop - box.clientHeight > 300;
  // 滚动事件每帧都来，值没变就别碰 DOM
  if (dom.btnScrollBottom.hidden !== !away) dom.btnScrollBottom.hidden = !away;
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
  state.draftFiles = [];
  renderAll();
  dom.input.focus();
  return session;
}

async function send() {
  const text = dom.input.value.trim();
  if ((!text && !state.draftImages.length && !state.draftFiles.length) || isStreaming()) return;
  if (!state.settings.apiKey) {
    openSettings();
    toast('先填写 API Key');
    return;
  }

  // 先把待发内容取出来：newSession() 会清空 draftImages，顺序反了会把图片丢掉
  const images = state.draftImages.slice();
  const files = state.draftFiles.slice();
  state.draftImages = [];
  state.draftFiles = [];
  dom.input.value = '';
  autoGrow();
  inputTrackValue = '';
  inputTrackAt = performance.now();
  // 同步清空输入框上方的附件栏，否则缩略图/文件方块会残留
  renderDraft();

  let session = currentSession();
  if (!session) session = newSession();
  // 已经发出去了，这条草稿没用了
  clearDraft(session);

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
        files,
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
    files,
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
  const controller = new AbortController();
  streams.set(session.id, { controller, msgId: assistantMsg.id });
  updateSendButton();

  const history = currentPath(session)
    .filter((m) => m !== assistantMsg)
    .map((m) => ({ role: m.role, content: m.content, images: m.images, files: m.files, ts: m.ts }));

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
    // 已经切到别的会话：内容继续在数据里累积，但绝不能画进当前会话的 DOM
    if (state.currentId !== session.id) return;
    // 用户正在框选文字时先不重建：replaceChild 会让选区错位、甚至直接消失
    if (textSelectionActive()) return;
    // 按 id 找节点，不缓存引用：避免节点被重建后引用失效；
    // 也不能用消息数组下标去索引 children —— DOM 只渲染当前分支，有分支后会错位成每帧一个新气泡
    const existing = renderedNode(assistantMsg);
    // 流式期间就地更新内容块，不重建整条消息：KaTeX、图片、选区都保持原样
    if (existing && assistantMsg.pending && updateStreamingNode(existing, assistantMsg)) {
      scrollToBottom();
      return;
    }
    const node = messageNode(assistantMsg, idx, session);
    if (existing) dom.messages.replaceChild(node, existing);
    else dom.messages.appendChild(node);
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
      signal: controller.signal,

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
          // 只有当前正在看的还是这条会话时才改顶栏标题
          if (state.currentId === session.id) dom.topTitle.textContent = session.title;
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
    streams.delete(session.id);
    assistantMsg.pending = false;
    assistantMsg.endedAt = Date.now();
    if (assistantMsg.reasoning && !assistantMsg.elapsedSecs) {
      assistantMsg.elapsedSecs = Math.max(1, Math.round((assistantMsg.endedAt - assistantMsg.startedAt) / 1000));
    }
    session.updatedAt = Date.now();
    persist(session);
    // 生成期间可能已经切到别的会话：只更新数据与侧栏，别去动当前会话的 DOM
    if (state.currentId === session.id) {
      renderMessages();
      if (state.settings.autoScrollEnd !== false) scrollToBottom(true);
    }
    renderSidebar();
    updateSendButton();
  }
}

async function regenerate(session, index) {
  if (isStreaming(session.id)) return;
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
  if (!msg || msg.role !== 'assistant' || isStreaming(session.id)) return;
  if (msg.search) {
    toast('带联网搜索的回答不支持续写');
    return;
  }
  if (!msg.content) {
    toast('这条回答还没有内容');
    return;
  }

  const history = session.messages.slice(0, index + 1)
    .map((m) => ({ role: m.role, content: m.content, images: m.images, files: m.files, ts: m.ts }));

  const baseContent = msg.content;
  const baseReasoning = msg.reasoning || '';
  const newBlocks = [];

  const controller = new AbortController();
  streams.set(session.id, { controller, msgId: msg.id });
  updateSendButton();

  let frame = 0;
  const paint = () => {
    const idx = session.messages.indexOf(msg);
    if (idx < 0) return;
    // 已经切到别的会话：内容继续累积，但不往当前会话的 DOM 里画
    if (state.currentId !== session.id) return;
    // 同上：用户正在框选文字时暂停重建，避免选区错位
    if (textSelectionActive()) return;
    // 同上：按 id 定位，避免存在分支时用数组下标取到错误节点而追加重复气泡
    const existing = renderedNode(msg);
    if (existing && msg.pending && updateStreamingNode(existing, msg)) {
      scrollToBottom();
      return;
    }
    const node = messageNode(msg, idx, session);
    if (existing) dom.messages.replaceChild(node, existing);
    else dom.messages.appendChild(node);
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
      signal: controller.signal,
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
    streams.delete(session.id);
    refresh();
    msg.pending = false;
    session.updatedAt = Date.now();
    persist(session);
    if (state.currentId === session.id) {
      renderMessages();
      if (state.settings.autoScrollEnd !== false) scrollToBottom(true);
    }
    updateSendButton();
  }
}

function editMessage(session, index) {
  const msg = session.messages[index];
  if (!msg || msg.role !== 'user' || isStreaming(session.id)) return;
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

const MAX_TXT_BYTES = 1024 * 1024; // 文本文件上限 1MB
const PASTE_TXT_MIN = 3000;        // 一次粘贴超过这个字数就转成文本附件

// 纯文本类文件：txt / json / md / csv / 日志 / 配置 / 常见源码都按文本读取，
// 发送时统一用「【文件：文件名】+ 原文」的格式
const TEXT_FILE_EXT = /\.(txt|text|md|markdown|json|jsonl|ndjson|csv|tsv|log|yaml|yml|xml|html?|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rs|rb|php|css|scss|less|ini|cfg|conf|env|sh|bash|bat|cmd|ps1|sql|toml|properties)$/i;

function isTextFile(file) {
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();
  if (TEXT_FILE_EXT.test(name)) return true;
  if (type.startsWith('text/')) return true;
  if (type === 'application/json' || type.endsWith('+json')) return true;
  if (type === 'application/xml' || type.endsWith('+xml')) return true;
  if (type === 'application/javascript') return true;
  return false;
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** 自动生成的文件名：取文本前 7 个字 */
function txtNameFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 7) || '文本';
}

function makeTxtFile(name, text) {
  const raw = String(text || '');
  return {
    id: db.newId(),
    name: String(name || 'text.txt').slice(0, 80),
    text: raw,
    size: raw.length,
  };
}

/** 把文本插到输入框（或编辑框）已有内容的前面 */
function insertTextAtFront(text, target) {
  const body = String(text || '');
  if (!body) return;
  if (target === 'editor' && state.editingId) {
    state.editingText = body + (state.editingText ? '\n' + state.editingText : '');
    renderMessages();
    focusEditor();
    return;
  }
  const existing = dom.input.value || '';
  const sep = existing && !existing.startsWith('\n') ? '\n' : '';
  dom.input.value = body + sep + existing;
  autoGrow();
  updateSendButton();
}

/** 把某个 txt 附件展开成正文并移出附件列表 */
function insertFileInto(files, index, target) {
  const file = files[index];
  if (!file) return;
  files.splice(index, 1);
  insertTextAtFront(file.text, target);
  if (target === 'editor' && state.editingId) {
    renderMessages();
    focusEditor();
  } else {
    renderDraft();
    updateSendButton();
  }
}

async function addTxtFiles(files, toEditor) {
  const list = Array.from(files).slice(0, 6);
  let added = 0;
  for (const file of list) {
    if (!isTextFile(file)) {
      toast('只支持图片和文本类文件');
      continue;
    }
    if (file.size > MAX_TXT_BYTES) {
      toast('文本文件太大了（超过 1MB）');
      continue;
    }
    try {
      const text = await readTextFile(file);
      const entry = makeTxtFile(file.name, text);
      if (toEditor && state.editingId) state.editingFiles.push(entry);
      else state.draftFiles.push(entry);
      added += 1;
    } catch (err) {
      toast(err.message || '文件读取失败');
    }
  }
  if (!added) return;
  if (toEditor && state.editingId) {
    renderMessages();
    focusEditor();
  } else {
    renderDraft();
    updateSendButton();
  }
  toast(`已添加 ${added} 个文本文件`);
}

/** 手机端一次粘贴超长文本：自动转成 txt 附件 */
function addPastedTextAsFile(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return;
  state.draftFiles.push(makeTxtFile(`${txtNameFromText(clean)}.txt`, clean));
  renderDraft();
  updateSendButton();
  toast('文本较长，已转为 txt 附件');
}

// 输入框内容追踪：一次 input 事件突然多出大量文字（粘贴 / 第三方输入法剪贴板）
let inputTrackValue = '';
let inputTrackAt = 0;

/**
 * 从 prev -> cur 的变化里切出「本次插入的文本」和去掉它之后的原文。
 * 用公共前后缀做差，兼容光标在中间插入、尾部追加等情形。
 */
function splitInsertion(prev, cur) {
  const max = Math.min(prev.length, cur.length);
  let start = 0;
  while (start < max && prev[start] === cur[start]) start += 1;
  let endPrev = prev.length;
  let endCur = cur.length;
  while (endPrev > start && endCur > start && prev[endPrev - 1] === cur[endCur - 1]) {
    endPrev -= 1;
    endCur -= 1;
  }
  return {
    inserted: cur.slice(start, endCur),
    restored: prev.slice(0, start) + prev.slice(endPrev),
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

/** txt 附件方块：长方形，显示文件名 */
function txtChip(file, opts = {}) {
  const cell = el('div', 'draft-file');
  if (opts.title) cell.title = opts.title;
  cell.appendChild(el('div', 'draft-file-name', file.name));
  const size = file.size || 0;
  const sizeText = size >= 1000 ? `${(size / 1000).toFixed(1)}k 字` : `${size} 字`;
  cell.appendChild(el('div', 'draft-file-size', sizeText));
  if (opts.onOpen) cell.addEventListener('dblclick', () => opts.onOpen());
  if (opts.onRemove) {
    const del = el('button', 'draft-del', '×');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onRemove();
    });
    cell.appendChild(del);
  }
  return cell;
}

function renderDraft() {
  let bar = dom.composer.querySelector('.draft-bar');
  if (!state.draftImages.length && !state.draftFiles.length) {
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
  state.draftFiles.forEach((file, i) => {
    bar.appendChild(txtChip(file, {
      title: '双击插入到输入框',
      onRemove: () => {
        state.draftFiles.splice(i, 1);
        renderDraft();
        updateSendButton();
      },
      onOpen: () => insertFileInto(state.draftFiles, i, 'draft'),
    }));
  });
  // 附件增删也会走这里：顺手把草稿存下来
  scheduleDraftSave();
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
    const gap = Number(state.settings.composerGap);
    const gapInput = document.getElementById('setGap');
    if (gapInput) {
      gapInput.value = String(Number.isFinite(gap) ? gap : 0);
      const gapLabel = document.getElementById('gapValue');
      if (gapLabel) gapLabel.textContent = gapInput.value;
    }
    const autoScrollInput = document.getElementById('setAutoScroll');
    if (autoScrollInput) autoScrollInput.checked = state.settings.autoScroll !== false;
    const autoScrollEndInput = document.getElementById('setAutoScrollEnd');
    if (autoScrollEndInput) autoScrollEndInput.checked = state.settings.autoScrollEnd !== false;

    const scaleInput = document.getElementById('setMsgScale');
    if (scaleInput) {
      const scale = Number(state.settings.msgScale);
      scaleInput.value = String(Number.isFinite(scale) && scale > 0 ? scale : 1);
      const scaleLabel = document.getElementById('scaleValue');
      if (scaleLabel) scaleLabel.textContent = Math.round(Number(scaleInput.value) * 100) + '%';
    }
  } catch (err) {
    console.error('填充设置失败', err);
  }
  modal.hidden = false;
  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.classList.add('open');
  applyViewport();
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.style.opacity = '0';
  modal.classList.remove('open');
  setTimeout(() => {
    modal.hidden = true;
    modal.style.display = 'none';
    // 设置面板关掉后把键盘避让恢复成聊天页的逻辑
    applyViewport();
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
    composerGap: Number($('setGap').value),
    autoScroll: $('setAutoScroll').checked,
    autoScrollEnd: $('setAutoScrollEnd').checked,
    msgScale: Number($('setMsgScale').value),
  });
  saveSettings();
  applyTheme();
  applyComposerGap();
  applyMsgScale();
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
  dom.btnMenu.addEventListener('click', openSidebar);
  dom.scrim.addEventListener('click', closeSidebar);

  const startNewChat = () => {
    openConversation(null);
    dom.input.focus();
  };
  dom.btnNew.addEventListener('click', startNewChat);
  if (dom.btnNewSidebar) dom.btnNewSidebar.addEventListener('click', startNewChat);

  inputTrackValue = dom.input.value || '';
  inputTrackAt = performance.now();

  dom.input.addEventListener('input', () => {
    // 开始在日常输入框里打字时，自动退出消息的就地编辑（编辑框复位到修改前）
    if (state.editingId) cancelEdit();
    scheduleDraftSave();

    const now = performance.now();
    const cur = dom.input.value;
    const grew = cur.length - inputTrackValue.length;
    // 一次 input 事件就多出 3000 字以上（系统粘贴、第三方输入法/插件剪贴板都走这里），
    // 手机和电脑都按长文本处理。
    if (grew >= PASTE_TXT_MIN) {
      const { inserted, restored } = splitInsertion(inputTrackValue, cur);
      if (inserted.trim().length >= PASTE_TXT_MIN) {
        dom.input.value = restored;
        addPastedTextAsFile(inserted);
        autoGrow();
        updateSendButton();
        inputTrackValue = restored;
        inputTrackAt = now;
        return;
      }
    }

    inputTrackValue = cur;
    inputTrackAt = now;
    autoGrow();
    updateSendButton();
  });

  // 一次粘贴超过 3000 字：转成 txt 附件，而不是把长文塞进输入框（手机和电脑都生效）
  dom.input.addEventListener('paste', (e) => {
    const data = e.clipboardData || window.clipboardData;
    const text = data ? data.getData('text') : '';
    if (!text || text.length <= PASTE_TXT_MIN) return;
    e.preventDefault();
    addPastedTextAsFile(text);
  });

  dom.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    // textarea 上的 enterkeyhint="send" 会让 iOS 键盘显示「发送」，但按键本身仍插入换行，
    // 所以必须在这里拦下改成发送；想换行就用输入栏里的换行按钮（手机）或 Shift+Enter（桌面）。
    e.preventDefault();
    send();
  });

  dom.btnSend.addEventListener('click', send);
  dom.btnStop.addEventListener('click', () => {
    // 只停当前会话的生成；别的会话在后台继续跑
    stopStream(state.currentId);
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
      { label: '文本文件（.txt）', run: () => dom.txtInput.click() },
    ]);
  });

  dom.btnSettings.addEventListener('click', openSettings);

  // 点气泡菜单的遮罩也能关闭（长按菜单关不掉时的兜底入口）
  if (dom.sheet) {
    dom.sheet.addEventListener('click', (e) => {
      if (e.target === dom.sheet) closeSheet();
    });
  }
  $('btnSettingsTop').addEventListener('click', openSettings);
  $('setTemp').addEventListener('input', (e) => {
    $('tempValue').textContent = Number(e.target.value).toFixed(1);
  });
  $('setGap').addEventListener('input', (e) => {
    const gap = Number(e.target.value);
    $('gapValue').textContent = String(gap);
    // 拖动时实时预览，点“保存”才会写进本地设置
    state.settings.composerGap = gap;
    applyComposerGap();
  });
  $('setAutoScroll').addEventListener('change', (e) => {
    state.settings.autoScroll = e.target.checked;
    applyFollowState();
  });
  $('setAutoScrollEnd').addEventListener('change', (e) => {
    state.settings.autoScrollEnd = e.target.checked;
  });
  $('setMsgScale').addEventListener('input', (e) => {
    const scale = Number(e.target.value);
    $('scaleValue').textContent = Math.round(scale * 100) + '%';
    // 实时预览，点“保存”才会写进本地设置
    state.settings.msgScale = scale;
    applyMsgScale();
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
  dom.chat.addEventListener('scroll', onChatScroll, { passive: true });

  // 手指向下拖 = 内容向上滚 = 用户在看历史：立刻停掉自动跟随（2px 就生效，别等滑很远）
  dom.chat.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) lastTouchY = e.touches[0].clientY;
  }, { passive: true });
  dom.chat.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (y - lastTouchY > 2) stickToBottom = false;
    lastTouchY = y;
  }, { passive: true });
  // 桌面端滚轮向上
  dom.chat.addEventListener('wheel', (e) => {
    if (e.deltaY < -1) stickToBottom = false;
  }, { passive: true });

  // 点击输入框（含发送按钮那一排）以外的区域时自动收起键盘
  const inComposer = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('.composer-wrap'));
  };
  document.addEventListener('pointerdown', (e) => {
    if (document.activeElement !== dom.input) return;
    if (inComposer(e.target)) return;
    dom.input.blur();
  }, { passive: true });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // 代码块的一键复制（markdown 渲染出来的「复制」按钮）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
    if (!btn) return;
    const box = btn.closest('.code');
    const codeEl = box ? box.querySelector('pre code') : null;
    const text = codeEl ? codeEl.textContent : '';
    if (text) copyText(text);
  });

  // 点击附件缩略图 / 消息里的图片：放大查看（同一组可左右切换）
  // 关键：在 pointerdown 那一刻就把「图片 + 同组清单」抓下来。流式输出每帧都会重建
  // 消息节点，等 click 时图片元素常已被替换，click 直接落空 —— 这就是生成过程中
  // 查看看器时灵时不灵的原因。改用 pointerup 判定轻点，节点被换掉也不影响。
  let pendingImageTap = null;
  let lastImageOpenAt = 0;
  const clearImageTap = () => {
    if (pendingImageTap && pendingImageTap.timer) clearTimeout(pendingImageTap.timer);
    pendingImageTap = null;
  };

  document.addEventListener('pointerdown', (e) => {
    clearImageTap();
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (!img || img.classList.contains('img-viewer-img')) return;
    const draftCell = img.closest('.draft-cell');
    const galleryImg = img.closest('.gallery');
    const editorImages = img.closest('.msg-editor-images');
    const mdImg = img.classList.contains('md-img');
    if (!draftCell && !galleryImg && !editorImages && !mdImg) return;
    const container = draftCell ? draftCell.parentElement : (galleryImg || editorImages || null);
    const list = container
      ? Array.from(container.querySelectorAll('img')).map((x) => x.src)
      : [img.src];
    const index = Math.max(0, list.indexOf(img.src));
    pendingImageTap = {
      list,
      index,
      x: e.clientX,
      y: e.clientY,
      at: Date.now(),
      // 长按是要弹消息菜单的，超过这个时间就不算「看大图」
      timer: setTimeout(clearImageTap, 450),
    };
  }, true);

  document.addEventListener('pointerup', (e) => {
    const tap = pendingImageTap;
    if (!tap) return;
    clearImageTap();
    if (Date.now() - tap.at > 450) return;
    if (Math.abs(e.clientX - tap.x) > 12 || Math.abs(e.clientY - tap.y) > 12) return; // 是滑动不是点击
    lastImageOpenAt = Date.now();
    openImageViewer(tap.list, tap.index);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('pointercancel', clearImageTap, true);

  // 兜底：没有 pointer 事件时仍走 click
  document.addEventListener('click', (e) => {
    if (Date.now() - lastImageOpenAt < 800) return; // 已经由 pointerup 打开过
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (!img) return;
    const draftCell = img.closest('.draft-cell');
    const gallery = img.closest('.gallery');
    const editorImages = img.closest('.msg-editor-images');
    const mdImg = img.classList.contains('md-img');
    if (!draftCell && !gallery && !editorImages && !mdImg) return;
    const container = draftCell ? draftCell.parentElement : (gallery || editorImages || null);
    const list = container
      ? Array.from(container.querySelectorAll('img')).map((x) => x.src)
      : [img.src];
    const index = Math.max(0, list.indexOf(img.src));
    openImageViewer(list, index);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // 键盘：ESC 关闭、左右切换
  document.addEventListener('keydown', (e) => {
    if (!viewerEl || viewerEl.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeImageViewer();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepImageViewer(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepImageViewer(1);
    }
  });

  bindDragDrop();
}

/* 桌面端拖拽上传：图片拖到输入框或就地编辑框即可添加 */
function bindDragDrop() {
  const isDesktop = () => document.documentElement.dataset.device === 'desktop';
  const composerZone = () => (dom.composer ? dom.composer.closest('.composer-wrap') : null);
  const zoneOf = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return null;
    // 修改框优先：拖到修改框就始终加到修改框，不会被聊天区规则抢走
    const editor = el.closest('.msg-editor');
    if (editor) return editor;
    // 侧栏、设置面板、图片查看器、弹层不接管
    if (el.closest('.sidebar, .modal, .img-viewer, .sheet')) return null;
    // 其余任何位置都落到当前输入框。
    // 注意不能用 .main：桌面端它被限宽居中，两侧空白不属于 .main，拖过去会没反应。
    return composerZone();
  };

  const addFiles = async (files, zone) => {
    const list = Array.from(files);
    if (!list.length) return;
    const toEditor = !!zone && zone.classList.contains('msg-editor');
    const images = list.filter((f) => f.type.startsWith('image/'));
    const txts = list.filter(isTextFile);
    if (!images.length && !txts.length) {
      toast('只支持图片和文本类文件');
      return;
    }
    if (txts.length) await addTxtFiles(txts, toEditor);
    let added = 0;
    for (const file of images) {
      if (file.size > 20 * 1024 * 1024) {
        toast('图片太大了（超过 20MB）');
        continue;
      }
      try {
        const img = await readImage(file);
        if (toEditor && state.editingId) state.editingImages.push(img);
        else state.draftImages.push(img);
        added += 1;
      } catch (err) {
        toast(err.message || '图片读取失败');
      }
    }
    if (!added) return;
    if (toEditor && state.editingId) {
      renderMessages();
      focusEditor();
    } else {
      renderDraft();
      updateSendButton();
    }
    toast(`已添加 ${added} 张图片`);
  };

  const clearZones = () => {
    document.querySelectorAll('.drop-active').forEach((n) => n.classList.remove('drop-active'));
  };

  // 拖到输入框区域时给整屏提示；拖到修改框只在修改框上高亮（保持原样）
  let hintEl = null;
  const showHint = (show) => {
    if (show && !hintEl) {
      hintEl = el('div', 'drop-hint');
      hintEl.innerHTML = '<div class="drop-hint-card">'
        + '<div class="drop-hint-text">文件和图片拖动到此处即可上传</div>'
        + '<div class="drop-hint-sub">图片 ≤ 20 MB，文本文件 ≤ 1 MB</div>'
        + '</div>';
      document.body.appendChild(hintEl);
    }
    if (hintEl) hintEl.hidden = !show;
  };

  document.addEventListener('dragover', (e) => {
    if (!isDesktop()) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    // 含文件就全局拦下默认行为，否则浏览器会把拖入的文件当导航直接打开
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const zone = zoneOf(e.target);
    clearZones();
    if (zone) zone.classList.add('drop-active');
    showHint(!!zone && !zone.classList.contains('msg-editor'));
  });

  document.addEventListener('dragleave', (e) => {
    if (!isDesktop()) return;
    const zone = zoneOf(e.target);
    if (zone) zone.classList.remove('drop-active');
  });

  document.addEventListener('dragend', () => {
    clearZones();
    showHint(false);
  });

  document.addEventListener('drop', (e) => {
    if (!isDesktop()) return;
    const files = e.dataTransfer && e.dataTransfer.files;
    clearZones();
    showHint(false);
    if (!files || !files.length) return;
    e.preventDefault();
    const zone = zoneOf(e.target);
    if (!zone) {
      toast('把文件拖到聊天区域或修改框上');
      return;
    }
    addFiles(files, zone);
  });
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

/** 抽屉动画时长：松手时按剩余距离给，距离短就收得快，避免固定 0.26s 的顿挫 */
function setDrawerDuration(ms) {
  const value = typeof ms === 'number' && ms > 0 ? Math.round(ms) : 260;
  document.documentElement.style.setProperty('--drawer-ms', value + 'ms');
}

let drawerOnTimer = 0;

/** .main 的 transform 只在抽屉活跃期间存在：常驻 transform 会让 .main 变成合成层，
    iOS 在合成层里画文本选区不可靠（框选框不显示、滚动闪烁）。 */
function setDrawerOn(active, ms) {
  const root = document.documentElement;
  clearTimeout(drawerOnTimer);
  drawerOnTimer = 0;
  if (active) {
    root.classList.add('drawer-on');
    return;
  }
  // 关闭时先留着，等滑出动画播完再撤掉合成层
  drawerOnTimer = setTimeout(() => root.classList.remove('drawer-on'), (ms || 260) + 80);
}

function openSidebar(ms) {
  setDrawerDuration(ms);
  setDrawerOn(true);
  dom.sidebar.classList.add('open');
  dom.scrim.classList.add('open');
  dom.sidebar.setAttribute('aria-hidden', 'false');
  // 进度变量与 .open 类保持一致，避免手势接着拖时位置跳一下
  document.documentElement.style.setProperty('--drawer-p', '1');
}

function closeSidebar(ms) {
  setDrawerDuration(ms);
  dom.sidebar.classList.remove('open');
  dom.scrim.classList.remove('open');
  dom.sidebar.setAttribute('aria-hidden', 'true');
  document.documentElement.style.setProperty('--drawer-p', '0');
  setDrawerOn(false, typeof ms === 'number' ? ms : 260);
}

/* 手机端会话栏抽屉：从左边缘向右滑跟手拉出，滑多少页面就移动多少；
   松手时进度超过阈值就把剩下那段滑完，否则回弹。已打开时在主区向左滑关闭。 */
function bindSwipeDrawer() {
  if (document.documentElement.dataset.device !== 'phone') return;

  const root = document.documentElement;
  const DEADZONE = 14; // 横向移动超过它才开始位移，避免轻微斜滑就拖动
  const drawerWidth = () => Math.min(window.innerWidth * 0.82, 320);

  let startX = 0;
  let startY = 0;
  let baseP = 0;
  let progress = 0;
  let tracking = false;
  let dragging = false;
  let raf = 0;
  let queued = 0;
  let startTime = 0;

  const isOpen = () => dom.sidebar.classList.contains('open');

  const queueProgress = (p) => {
    const value = Math.max(0, Math.min(1, p));
    progress = value;
    queued = value;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      root.style.setProperty('--drawer-p', String(queued));
    });
  };

  const detach = () => document.removeEventListener('touchmove', onMove);

  const finish = (commit) => {
    if (!tracking) return;
    detach();
    tracking = false;
    if (!dragging) return;
    dragging = false;
    // 先把最后一帧的进度落地，再取消挂起的 rAF，否则过渡开始后还会跳一下
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    root.style.setProperty('--drawer-p', String(progress));
    root.classList.remove('drawer-dragging');
    // toward = 朝「翻转当前状态」的方向走了多少。跨过中点（或被甩动）就翻转状态，
    // 否则回到原状态。翻转结果必须按 baseP 判断 —— 否则关闭手势会被当成“应该打开”，
    // 侧栏就再也滑不回去了。
    const toward = baseP > 0.5 ? 1 - progress : progress;
    const elapsed = Math.max(1, Date.now() - startTime);
    const speed = Math.abs(progress - baseP) / elapsed; // 进度 / 毫秒
    const flung = elapsed < 320 && speed > 0.0012;
    const switched = commit && (toward > 0.5 || (flung && toward > 0.1));
    const target = switched ? (baseP > 0.5 ? 0 : 1) : (baseP > 0.5 ? 1 : 0);
    // 剩余距离越短动画越快：只剩一点点还要等满 0.26s 就是最明显的顿挫来源
    const remaining = Math.abs(target - progress);
    const ms = Math.min(300, Math.max(110, Math.round(remaining * 340)));
    // 下一帧再切目标值，回弹/滑完的过渡才真正生效
    requestAnimationFrame(() => (target ? openSidebar(ms) : closeSidebar(ms)));
  };

  function onMove(e) {
    if (!tracking) return;
    if (e.touches.length !== 1) { finish(false); return; }
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < DEADZONE) return; // 死区：横向走够才判定，避免轻微斜滑就拖动
      // 横向必须明显压过纵向（斜着滑要交还给页面滚动）
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { finish(false); return; }
      const wantSign = baseP > 0.5 ? -1 : 1;
      if (Math.sign(dx) !== wantSign) { finish(false); return; }
      dragging = true;
      root.classList.add('drawer-dragging');
      setDrawerOn(true); // 开始拖时才让 .main 变成可位移
    }
    if (e.cancelable) e.preventDefault();
    // 扣掉死区再跟手：越过死区那一瞬间不会突然跳一段
    const moved = Math.max(0, Math.abs(dx) - DEADZONE) * Math.sign(dx);
    queueProgress(baseP + moved / drawerWidth());
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const node = t.target;
    // 排除：横向可滚动区域、输入框、图片查看器与各种弹层。
    // 侧栏内部不再排除 —— 打开状态下直接会话栏上向左滑也能把它推回去。
    if (node && node.closest && node.closest('.code pre, .table-wrap, textarea, input, .img-viewer, .sheet, .modal')) return;
    // 整屏都能起手；是否真的进入抽屉手势由 onMove 的方向与距离判定决定
    baseP = isOpen() ? 1 : 0;
    startX = t.clientX;
    startY = t.clientY;
    progress = baseP;
    startTime = Date.now();
    tracking = true;
    dragging = false;
    // 确认是抽屉候选后才挂非 passive 监听，平时滚动完全不经过 JS
    document.addEventListener('touchmove', onMove, { passive: false });
  }, { passive: true });

  document.addEventListener('touchend', () => finish(true), { passive: true });
  document.addEventListener('touchcancel', () => finish(false), { passive: true });
}

/* ------------------------------ 框选工具条 ------------------------------ */

/** 手机端长按正文会进入系统文本选择。选区出现时给一组操作（复制选中/复制全文/修改/删除），
   否则长按就只剩框选，原来的长按菜单进不来了。 */
function bindSelectionBar() {
  if (document.documentElement.dataset.device !== 'phone') return;

  const bar = el('div', 'sel-bar');
  bar.hidden = true;
  document.body.appendChild(bar);

  let timer = 0;
  const hide = () => { bar.hidden = true; };
  const clearSelection = () => {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  };

  const addButton = (label, run) => {
    const btn = el('button', 'sel-btn', label);
    btn.type = 'button';
    let lastRun = 0;
    const fire = (e) => {
      if (Date.now() - lastRun < 400) return; // touchend 与 click 去重
      lastRun = Date.now();
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    // 触屏上必须是 touchend 这类「用户手势」里才能写剪贴板：
    // pointerdown 里执行 copy 会被 iOS 判定为非用户触发 → 一直报复制失败。
    btn.addEventListener('touchend', fire, { passive: false });
    // 桌面 / touchend 没来的情况
    btn.addEventListener('click', fire);
    // 按下时阻止选区折叠，否则按钮会被 refresh 重建成别的元素
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
    });
    bar.appendChild(btn);
    return btn;
  };

  const refresh = () => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? String(sel).trim() : '';
    const selecting = document.documentElement.classList.contains('sel-mode');

    // 框选模式：只给「复制选中 / 完成」；此时可能还没有选区（等用户拖手柄）
    if (selecting) {
      bar.innerHTML = '';
      const copyBtn = addButton('复制选中', async () => {
        if (!text) return;
        const ok = await copyText(text);
        if (ok) exitTextSelect(); // 复制成功就收起工具条、退出框选模式
      });
      copyBtn.disabled = !text;
      addButton('完成', exitTextSelect);
      bar.hidden = false;
      return;
    }

    if (!text) { hide(); return; }
    const anchor = sel.anchorNode;
    const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const msgEl = anchorEl && anchorEl.closest ? anchorEl.closest('.msg') : null;
    const session = currentSession();
    const msg = msgEl && session ? session.messages.find((m) => m.id === msgEl.dataset.id) : null;
    if (!msg) { hide(); return; }
    const index = session.messages.indexOf(msg);

    bar.innerHTML = '';
    addButton('复制选中', () => { copyText(text); clearSelection(); hide(); });
    addButton('复制全文', () => { copyText(msg.content || ''); clearSelection(); hide(); });
    if (msg.role === 'user') {
      addButton('修改', () => { clearSelection(); hide(); editMessage(session, index); });
    }
    addButton('删除', () => { clearSelection(); hide(); deleteMessage(msg, session); });
    bar.hidden = false;
  };
  refreshSelectBar = refresh;

  // 选区变化很频繁，稍微防抖再算
  document.addEventListener('selectionchange', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 60);
  });

  // 框选模式下，点到消息之外的空白就退出（拖手柄时点在文本上，不受影响）
  document.addEventListener('pointerdown', (e) => {
    if (!document.documentElement.classList.contains('sel-mode')) return;
    const node = e.target;
    if (node && node.closest && (node.closest('.sel-bar') || node.closest('.msg.select-mode'))) return;
    exitTextSelect();
  }, true);
}

/* ------------------------------ 启动 ------------------------------ */

// 无键盘时的可视区高度基准。iOS 独立 PWA 里键盘弹起时 innerHeight 也会跟着缩，
// 用历史最大可视高度做基准才能稳定判断出“现在是键盘弹起状态”。
let viewportBaseline = 0;

/** 键盘高度（像素）。用基准高度减当前可视高度，兜底不小于 0。 */
function keyboardHeight() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  if (vv.height > viewportBaseline) viewportBaseline = vv.height;
  const base = viewportBaseline || window.innerHeight;
  return Math.max(0, Math.round(base - vv.height));
}

/* 手机端锁死页面缩放：双指捏合、双击都不许把整页放大。
   iOS 从 10 起忽略 viewport 的 user-scalable=no（无障碍策略），双指导航只能靠
   Safari 私有的 gesture 事件拦；touchmove 两指兜底，防止手势事件漏网。 */
function lockPageZoom() {
  const block = (e) => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
    document.addEventListener(name, block, { passive: false });
  });
  // 这里刻意不挂全局非 passive 的 touchmove 兜底：iOS 会强制每个触摸帧同步回主线程，
  // 快速上滑时掉帧、露出白块，代价远大于收益。手势事件 + CSS touch-action 已经够了。
}

// 由 bindViewport 赋值；设置面板关闭等时机需要主动重新套用一次布局
let applyViewport = () => {};

function bindViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  let lastKey = '';
  let queued = false;
  const apply = () => {
    const root = document.documentElement;
    if (vv.height > viewportBaseline) viewportBaseline = vv.height;
    const kb = keyboardHeight();
    // 兜底：个别 iOS PWA 里可视区变化幅度可能很小，输入框聚焦且高度明显变矮也算键盘弹起
    const chatInputFocused = document.activeElement === dom.input;
    const keyboardOpen = kb > 120 || (chatInputFocused && vv.height < viewportBaseline - 60);
    const settingsOpen = !!dom.modal && !dom.modal.hidden;
    const baseHeight = viewportBaseline || window.innerHeight;
    // 页面滚动时 visualViewport 的 scroll 也会触发。值没变就没必要重写样式：
    // 改 --vvh/--vvy 会让整个固定布局重排，快速上滑时会掉帧并露出白块。
    const key = [kb, keyboardOpen, settingsOpen, vv.height, vv.offsetTop, baseHeight].join('|');
    if (key === lastKey) return;
    lastKey = key;
    const fullHeight = baseHeight + 'px';

    // 设置面板打开时不让整页上移避让键盘：.app 保持原位，只把键盘高度交给弹层（--kb），
    // 由弹层自己收缩让输入框留在键盘上方。否则 .app 收缩并底部对齐会把 API Key 等输入框顶出可视区。
    root.style.setProperty('--kb', settingsOpen && keyboardOpen ? kb + 'px' : '0px');

    if (settingsOpen && keyboardOpen) {
      root.style.setProperty('--vvh', fullHeight);
      root.style.setProperty('--vvy', '0px');
      root.classList.remove('kb-open');
      return;
    }

    // 键盘弹起时让整个应用跟随可视区域收缩，并用 offsetTop 抵消页面整体上移
    root.style.setProperty('--vvh', vv.height + 'px');
    root.style.setProperty('--vvy', vv.offsetTop + 'px');
    root.classList.toggle('kb-open', keyboardOpen);
    if (document.activeElement === dom.input) scrollToBottom(true);
  };
  // 用 rAF 合并同一帧内的多次触发，避免键盘动画期间反复重排
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  };
  applyViewport = apply;
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();

  // 横竖屏切换后基准会失效，重新取一次
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      viewportBaseline = vv.height;
      apply();
    }, 250);
  });

  // 兜底：部分 iOS 版本只有 focus 之后才更新 visualViewport
  dom.input.addEventListener('focus', () => setTimeout(apply, 120));
  dom.input.addEventListener('blur', () => setTimeout(apply, 120));

  // 设置面板里的输入框同样要兜底，否则键盘收起后 --kb 不会被复位
  for (const id of ['setKey', 'setBase', 'setModel', 'setSystem']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.addEventListener('focus', () => setTimeout(apply, 120));
    node.addEventListener('blur', () => setTimeout(apply, 120));
  }
}

/* ------------------------------ 版本更新检测 ------------------------------ */

let assetStamp = '';
let updateNoticeShown = false;

/** 取线上 js/app.js 的版本指纹（Last-Modified + 大小），HEAD 请求不下载正文 */
async function fetchAssetStamp() {
  try {
    const res = await fetch('js/app.js?t=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return '';
    return [
      res.headers.get('last-modified') || '',
      res.headers.get('content-length') || '',
    ].join('|');
  } catch {
    return '';
  }
}

function showUpdateNotice() {
  if (updateNoticeShown) return;
  updateNoticeShown = true;
  const bar = el('div', 'update-bar');
  bar.textContent = '发现新版本，点击刷新';
  bar.addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
}

async function checkForUpdate() {
  const stamp = await fetchAssetStamp();
  if (!stamp) return;
  if (!assetStamp) {
    assetStamp = stamp;
    return;
  }
  if (stamp !== assetStamp) showUpdateNotice();
}

function bindUpdateCheck() {
  // 启动时记录当前线上版本，之后每分钟检查一次
  checkForUpdate();
  setInterval(checkForUpdate, 60000);
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
  applyDeviceClass();
  applyComposerGap();
  applyMsgScale();
  applyFollowState();
  lockPageZoom();
  bindDeviceWatchers();
  bindEvents();
  bindSwipeDrawer();
  bindSelectionBar();
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
    if (files && files.length) {
      if (state.editingId) await addImagesToEdit(files);
      else await addImages(files);
    }
    e.target.value = '';
  });

  dom.txtInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length) await addTxtFiles(files, !!state.editingId);
    e.target.value = '';
  });

  renderAll();

  if (!state.settings.apiKey) {
    setTimeout(() => openSettings(), 400);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  bindUpdateCheck();

  // 「回到底部」按钮按输入框的实际高度定位，输入框变高/键盘弹起时自动跟着走
  const composerWrap = dom.composer && dom.composer.closest ? dom.composer.closest('.composer-wrap') : null;
  if (composerWrap) {
    const syncComposerHeight = () => {
      document.documentElement.style.setProperty('--composer-h', composerWrap.offsetHeight + 'px');
    };
    syncComposerHeight();
    if ('ResizeObserver' in window) {
      new ResizeObserver(syncComposerHeight).observe(composerWrap);
    }
  }

  // 调试开关：开启后会把流式响应里的工具调用、引用等字段打到控制台
  window.__dsDebug = true;

  // 调试钩子：Console 里可以直接检查元素和手动触发
  window.__ds = { state, dom, openSettings, closeSettings, send, renderAll };
  window.__dsCheck = () =>
    Object.keys(dom).filter((k) => !dom[k]).concat(['all-ok']);
}

init();

import { t, setLocale, applyDom, getLocale, isNewChatTitle } from './i18n.js';

const api = window.simple || window.sinpo;

// 界面层异常统一上报主进程写入诊断日志，闪退后可回溯
window.addEventListener('error', (e) => {
  api.reportError?.('界面脚本报错', {
    message: e.message,
    source: e.filename,
    line: e.lineno,
    stack: e.error && e.error.stack
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  api.reportError?.('界面未处理的 Promise 拒绝', {
    message: r && (r.message || String(r)),
    stack: r && r.stack
  });
});

const state = {
  themePref: 'system',
  theme: 'light',
  autoSave: true,
  recents: [],
  models: [],
  currentModelId: '',
  localFiles: [],
  modelsDir: '',
  searchSites: [],
  workspace: '',
  skills: [],
  rules: [],
  persona: '',
  snapshots: [],
  sessions: [],
  tabs: [],
  activeTab: null,
  attachments: [],
  contextPaths: [],
  skillId: null,
  sending: false,
  aborting: false,
  queue: [],
  liveAssistant: null,
  sidebar: false,
  fileTree: true,
  treeCache: {},
  treeOpen: new Set(),
  previewPath: '',
  ctxRel: '',
  ctxJustOpened: false,
  livePaintTimer: null,
  dl: { taskId: null, purpose: null }
};

function $(id) { return document.getElementById(id); }
function uid() { return `s_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`; }

function applyTheme(resolved) {
  state.theme = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  $('status-theme').textContent = t(resolved === 'dark' ? 'themeDark' : 'themeLight');
}

function currentModel() {
  return state.models.find((m) => m.id === state.currentModelId) || state.models[0];
}

function modelLabel() {
  const m = currentModel();
  return m ? `${m.name} · ${m.model}` : t('noModel');
}

function setWorkspace(dir) {
  state.workspace = dir || '';
  $('status-ws').textContent = dir || t('noWorkspace');
  $('status-model').textContent = modelLabel();
}

/** 切换语言后刷新动态生成的界面，静态节点走 applyDom */
function applyLocaleUi() {
  applyDom();
  for (const tab of state.tabs) {
    if (isNewChatTitle(tab.title)) tab.title = t('newChat');
  }
  setWorkspace(state.workspace);
  renderRecents();
  renderModelMenu();
  renderSidebar();
  renderTabs();
  renderMessages();
  if (state.workspace) {
    $('tree-root-name').textContent = (state.workspace.split(/[\\/]/).pop() || t('project')).toUpperCase();
    renderFileTree();
  } else {
    $('tree-root-name').textContent = t('noProject');
    $('tree-body').innerHTML = `<div class="hint" style="padding:8px">${t('openProjectFirst')}</div>`;
  }
  if (state.previewPath) $('preview-path').textContent = state.previewPath;
  const sendBtn = $('btn-send');
  if (sendBtn) sendBtn.textContent = state.sending ? t('stop') : t('send');
}

function showWelcome() {
  $('view-welcome').classList.remove('hidden');
  $('view-chat').classList.add('hidden');
}

function showChat() {
  $('view-welcome').classList.add('hidden');
  $('view-chat').classList.remove('hidden');
}

function closeMenus() {
  if (state.ctxJustOpened) return;
  document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
  $('model-menu').classList.remove('show');
  $('slash-menu').classList.add('hidden');
  $('at-menu').classList.add('hidden');
  hideCtxMenu();
}

function hideCtxMenu() {
  const el = $('ctx-menu');
  if (el) el.classList.add('hidden');
}

function showFileCtx(e, rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath) return;
  e.preventDefault();
  e.stopPropagation();
  state.ctxRel = filePath;
  state.ctxJustOpened = true;
  const menu = $('ctx-menu');
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 48);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  setTimeout(() => { state.ctxJustOpened = false; }, 400);
}

async function revealInFolder(rel) {
  hideCtxMenu();
  try {
    await api.showInFolder(rel);
  } catch (err) {
    alert(err.message || err);
  }
}

function renderRecents(all = false) {
  const list = all ? state.recents : state.recents.slice(0, 5);
  $('recent-list').innerHTML = list.length
    ? list.map((r) => `<div class="recent-item" data-path="${encodeURIComponent(r.path)}"><span>${escapeHtml(r.name)}</span><span class="path">${escapeHtml(r.path)}</span></div>`).join('')
    : `<div class="hint">${t('noRecents')}</div>`;
  const menu = $('menu-recent');
  menu.innerHTML = state.recents.length
    ? state.recents.map((r) => `<button data-act="open-path" data-path="${encodeURIComponent(r.path)}">${escapeHtml(r.name)}</button>`).join('')
    : `<button disabled>${t('noRecords')}</button>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openModal(html) {
  $('modal-card').classList.remove('wide');
  $('modal-card').onclick = null;
  $('modal-card').innerHTML = html;
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }

async function openProject(dir) {
  await persistSession();
  const ws = dir ? await api.setWorkspace(dir) : await api.openProject();
  if (!ws) return;
  setWorkspace(ws);
  await refreshMeta();
  state.tabs = state.tabs.filter((t) => sameWorkspace(t.workspace || ws, ws));
  await restoreLastSession(ws);
  showChat();
  renderTabs();
  renderMessages();
}

async function refreshMeta() {
  state.skills = await api.listSkills();
  state.rules = await api.listRules();
  state.snapshots = await api.listSnapshots();
  renderSidebar();
  await loadFileTree();
}

function activeSession() {
  return state.tabs.find((t) => t.id === state.activeTab);
}

function sameWorkspace(a, b) {
  const n = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) && n(a) === n(b);
}

function newTab() {
  const tab = { id: uid(), title: t('newChat'), messages: [], workspace: state.workspace, undone: [], context: emptyContext() };
  state.tabs.push(tab);
  state.activeTab = tab.id;
}

function emptyContext() {
  return { skillId: null, contextPaths: [], attachments: [] };
}

function applyTabContext(tab) {
  const ctx = tab?.context || emptyContext();
  state.skillId = ctx.skillId || null;
  state.contextPaths = Array.isArray(ctx.contextPaths) ? [...ctx.contextPaths] : [];
  state.attachments = Array.isArray(ctx.attachments)
    ? ctx.attachments.filter((a) => a && a.path).map((a) => ({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() }))
    : [];
  renderChips();
}

async function applyTabWorkspace(tab) {
  const ws = tab?.workspace || '';
  if (!ws || sameWorkspace(ws, state.workspace)) return;
  closeCodePreview();
  const next = await api.setWorkspace(ws);
  setWorkspace(next || ws);
  await refreshMeta();
}

async function switchToTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (state.activeTab !== id) await persistSession();
  state.activeTab = id;
  applyTabContext(tab);
  await applyTabWorkspace(tab);
  renderTabs();
  renderMessages();
}

async function restoreLastSession(ws) {
  const items = await api.loadSessions();
  const mine = items.filter((s) => sameWorkspace(s.workspace, ws));
  const last = mine.find((s) => (s.messageCount || 0) > 0) || mine[0];
  if (!last) {
    if (!state.tabs.length) newTab();
    return;
  }
  const existing = state.tabs.find((t) => t.id === last.id);
  if (existing) {
    state.activeTab = last.id;
    applyTabContext(existing);
    return;
  }
  try {
    const data = await api.loadSession(last.id);
    if (!data.messages?.length) {
      if (!state.tabs.length) newTab();
      return;
    }
    const tab = {
      id: data.id,
      title: data.title || t('unnamed'),
      messages: data.messages || [],
      workspace: data.workspace || ws,
      undone: data.undone || [],
      context: data.context || emptyContext()
    };
    state.tabs.push(tab);
    state.activeTab = data.id;
    applyTabContext(tab);
  } catch {
    if (!state.tabs.length) newTab();
  }
}

async function refreshAfterRestore() {
  await loadFileTree();
  if (state.previewPath) {
    try { await openCodePreview(state.previewPath); } catch { /* 文件可能已删 */ }
  }
  state.snapshots = await api.listSnapshots();
  renderSidebar();
}

/**
 * 还原前的确认弹窗，把影响范围说清楚，避免误点一下就回滚
 * @param {{label?: string, createdAt?: string, changes?: Array}} snap 快照信息
 * @returns {Promise<boolean>} 用户是否确认还原
 */
function confirmRestore(snap) {
  const changes = snap?.changes || [];
  return new Promise((resolve) => {
    const list = changes.map((c) => {
      const tag = c.existed === false ? t('willDelete') : t('overwrite');
      return `<div class="file-row"><span>${escapeHtml(c.path)}</span><span class="desc">${tag}</span></div>`;
    }).join('') || `<div class="hint">${t('noSnapFiles')}</div>`;
    const time = snap?.createdAt ? ` · ${new Date(snap.createdAt).toLocaleString()}` : '';
    openModal(`<h3>${t('restoreTitle')}</h3>
      <p class="hint">${escapeHtml(snap?.label || t('autoSnap'))}${time} · ${t('filesCount', { n: changes.length })}</p>
      <div class="restore-warn">${t('restoreWarn')}</div>
      <div class="restore-files">${list}</div>
      <div class="modal-actions">
        <button id="m-cancel">${t('cancel')}</button>
        <button class="danger" id="m-confirm">${t('restoreOk')}</button>
      </div>`);
    const done = (ok) => { closeModal(); resolve(ok); };
    $('m-cancel').onclick = () => done(false);
    $('m-confirm').onclick = () => done(true);
    // 焦点落在取消上，回车不会误触发还原
    $('m-cancel').focus();
  });
}

function renderTabs() {
  $('tabs').innerHTML = state.tabs.map((tab) => `
    <button class="tab ${tab.id === state.activeTab ? 'active' : ''}" data-id="${tab.id}" title="${t('renameTabHint')}">
      ${escapeHtml(tab.title)} <span class="x" data-close="${tab.id}">×</span>
    </button>`).join('');
}

function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || '');
}

const lightbox = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 };

function applyLightbox() {
  const img = $('lightbox-img');
  if (!img) return;
  img.style.transform = `translate(${lightbox.x}px, ${lightbox.y}px) scale(${lightbox.scale})`;
}

function openLightbox(src) {
  if (!src) return;
  lightbox.scale = 1;
  lightbox.x = 0;
  lightbox.y = 0;
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
  applyLightbox();
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').removeAttribute('src');
}

function renderChips() {
  const bits = [];
  if (state.skillId) {
    const s = state.skills.find((x) => x.id === state.skillId);
    bits.push(`<span class="chip">/${escapeHtml(s?.name || state.skillId)} <button data-rm="skill">×</button></span>`);
  }
  for (const p of state.contextPaths) {
    bits.push(`<span class="chip">@${escapeHtml(p)} <button data-rm="ctx" data-p="${encodeURIComponent(p)}">×</button></span>`);
  }
  for (const a of state.attachments) {
    if (a.preview) {
      bits.push(`<span class="chip chip-img"><img src="${a.preview}" alt="${escapeHtml(a.name)}" data-zoom-src="${a.preview}"><button data-rm="att" data-p="${encodeURIComponent(a.path)}">×</button></span>`);
    } else {
      bits.push(`<span class="chip">${escapeHtml(a.name)} <button data-rm="att" data-p="${encodeURIComponent(a.path)}">×</button></span>`);
    }
  }
  $('chips').innerHTML = bits.join('');
}

function renderQueue() {
  const el = $('queue');
  if (!el) return;
  if (!state.queue.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = state.queue.map((item, i) =>
    `<span class="queue-item"><span class="q-no">${i + 1}</span>${escapeHtml(clipText(item || t('attachment'), 50))}<button data-rm-queue="${i}" title="${t('remove')}">×</button></span>`
  ).join('');
}

async function addAttachments(list) {
  for (const a of list || []) {
    if (!a?.path) continue;
    if (state.attachments.some((x) => x.path === a.path)) continue;
    const item = {
      path: a.path,
      name: a.name || a.path.split(/[\\/]/).pop()
    };
    if (isImageName(item.name)) {
      try {
        item.preview = await api.filePreview(item.path);
      } catch {
        /* 没有缩略图就显示文件名 */
      }
    }
    state.attachments.push(item);
  }
  renderChips();
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function fileToAttachment(file) {
  if (file.path) return { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() };
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 40 * 1024 * 1024) throw new Error(`文件过大：${file.name}`);
  return api.savePasteFile({
    name: file.name || 'clipboard.png',
    mime: file.type || '',
    base64: bufToB64(buf)
  });
}

async function attachmentsFromPasteEvent(e) {
  const out = [];
  const seen = new Set();
  let files = [...(e.clipboardData?.files || [])];
  if (!files.length) {
    for (const item of e.clipboardData?.items || []) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  for (const file of files) {
    const key = file.path || `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(await fileToAttachment(file));
  }
  return out;
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function thinkSummary(m) {
  if (m.thinkingOpen) {
    if (m.status) return m.status;
    const tools = (m.thinking || []).filter((s) => s.type === 'tool');
    const lastTool = tools[tools.length - 1];
    if (lastTool) return `${t('running')} · ${clipText(lastTool.text, 28)}`;
    const last = (m.thinking || [])[m.thinking.length - 1];
    if (last?.type === 'reason') return t('reasoning');
    return m.text ? t('generating') : t('thinking');
  }
  const tools = (m.thinking || []).filter((s) => s.type === 'tool');
  return tools.length ? t('thinkSteps', { n: tools.length }) : t('think');
}

function thinkStepsHtml(m) {
  let list = (m.thinking || []).filter((s) => s.type === 'tool' || s.type === 'reason');
  if (m.thinkingOpen && list.length > 8) list = list.slice(-8);
  const html = list.map((s) => {
    const cls = s.type === 'reason' ? 'reason' : 'step';
    const text = s.type === 'reason' ? clipText(s.text, 280) : s.text;
    return `<div class="${cls}">${escapeHtml(text)}</div>`;
  }).join('');
  if (html) return html;
  if (m.thinkingOpen && m.status) return '';
  return `<div class="step">${t('noSteps')}</div>`;
}

function renderThink(m, idx) {
  const hasStatus = !!(m.thinkingOpen && m.status);
  if (!m.thinking?.length && !hasStatus) return '';
  const live = m.thinkingOpen ? 'live' : '';
  const steps = m.thinkExpanded ? `<div class="think-steps">${thinkStepsHtml(m)}</div>` : '';
  return `<details class="think-block ${live}" data-msg-i="${idx}" ${m.thinkExpanded ? 'open' : ''}>
    <summary>${escapeHtml(thinkSummary(m))}</summary>
    ${steps}
  </details>`;
}

function renderMessages() {
  const box = $('messages');
  const keep = box.scrollTop;
  const tab = activeSession();
  const msgs = tab?.messages || [];
  box.classList.toggle('empty-center', msgs.length === 0);
  if (!msgs.length) {
    box.innerHTML = '';
    updateUndoRedo();
    return;
  }
  box.innerHTML = msgs.map((m, i) => {
    if (m.role === 'tool-note') return '';
    let extra = '';
    if (m.changes?.length) {
      extra = `<div class="file-card">
        <div class="file-card-head">
          <button type="button" class="file-card-toggle" data-expand-files>${t('changedFiles', { n: m.changes.length })}</button>
          ${m.snapshotId ? `<button type="button" data-restore="${m.snapshotId}">${t('restoreThis')}</button>` : ''}
        </div>
        <div class="file-card-files">
          ${m.changes.map((c) => `<div class="file-row">
            <span class="file-link" data-preview-file="${encodeURIComponent(c.path)}" title="${t('previewHint')}">${escapeHtml(c.path)}</span>
            <button type="button" class="file-reveal" data-reveal="${encodeURIComponent(c.path)}" title="${t('showInFolder')}">${t('openLocation')}</button>
          </div>`).join('')}
        </div>
      </div>`;
    }
    const thumbs = (m.images || []).map((src) => `<img class="msg-thumb" src="${src}" alt="" data-zoom-src="${src}">`).join('');
    const inner = `${thumbs}${m.text ? escapeHtml(m.text) : ''}`;
    const bubble = inner ? `<div class="bubble">${inner}</div>` : '';
    const liveAttr = m === state.liveAssistant ? ' data-live="1"' : '';
    return `<div class="msg ${m.role}" data-msg-i="${i}"${liveAttr}>
      <div class="role">${m.role === 'user' ? t('you') : t('assistantName')}
        <span>
          ${m.role === 'user' ? `<button class="msg-refill" data-refill="${i}" title="${t('refillTitle')}">${t('refill')}</button>` : ''}
          <button class="msg-fork" data-fork="${i}" title="${t('forkTitle')}">${t('fork')}</button>
        </span>
      </div>
      ${m.role === 'assistant' ? renderThink(m, i) : ''}${bubble}${extra}
    </div>`;
  }).join('');
  box.scrollTop = state.sending ? keep : box.scrollHeight;
  updateUndoRedo();
}

function scrollMessagesToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function flushLivePaint() {
  if (state.livePaintTimer) {
    clearTimeout(state.livePaintTimer);
    state.livePaintTimer = null;
  }
}

function scheduleLivePaint() {
  if (state.livePaintTimer) return;
  state.livePaintTimer = setTimeout(() => {
    state.livePaintTimer = null;
    paintLiveAssistant();
  }, 100);
}

function paintLiveAssistant() {
  const last = state.liveAssistant;
  if (!last) return;
  const tab = activeSession();
  if (!tab) return;
  const idx = tab.messages.indexOf(last);
  if (idx < 0) return;
  let el = document.querySelector('.msg.assistant[data-live="1"]');
  if (!el) {
    renderMessages();
    return;
  }
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  el.setAttribute('data-msg-i', String(idx));
  let think = el.querySelector('.think-block');
  if (!think && (last.thinking?.length || (last.thinkingOpen && last.status))) {
    const wrap = document.createElement('div');
    wrap.innerHTML = renderThink(last, idx);
    think = wrap.firstElementChild;
    if (think) {
      const bubble = el.querySelector('.bubble');
      el.insertBefore(think, bubble || null);
    }
  }
  if (think) {
    think.classList.toggle('live', !!last.thinkingOpen);
    think.setAttribute('data-msg-i', String(idx));
    const sum = think.querySelector('summary');
    if (sum) sum.textContent = thinkSummary(last);
    if (last.thinkExpanded) {
      let steps = think.querySelector('.think-steps');
      if (!steps) {
        steps = document.createElement('div');
        steps.className = 'think-steps';
        think.appendChild(steps);
      }
      steps.innerHTML = thinkStepsHtml(last);
    }
  }
  if (last.text) {
    let bubble = el.querySelector('.bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'bubble';
      el.appendChild(bubble);
    }
    bubble.textContent = last.text;
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function uniqueSkills() {
  const map = new Map();
  for (const s of state.skills) {
    if (!map.has(s.id)) map.set(s.id, s);
  }
  return [...map.values()];
}

function skillListHtml(skills) {
  if (!skills.length) return `<div class="hint">${t('noSkills')}</div>`;
  return skills.map((s, i) => {
    const scope = s.scope === 'workspace' ? t('scopeProject') : t('scopeGlobal');
    const pri = s.priority || i + 1;
    const covered = s.active === false;
    return `<div class="skill-li${covered ? ' covered' : ''}" draggable="true" data-id="${escapeHtml(s.id)}" data-scope="${s.scope || 'app'}">
      <span class="drag-handle" title="${t('dragPri')}">⋮⋮</span>
      <span class="pri">${pri}</span>
      <button type="button" class="skill-li-name" data-skill="${s.id}">/${escapeHtml(s.name)}</button>
      <span class="scope-tag">${scope}</span>
      <span class="desc">${escapeHtml(s.desc || '')}</span>
      ${covered ? `<span class="covered-tag">${t('covered')}</span>` : ''}
      <button type="button" class="skill-edit" data-edit-skill="${s.id}" data-edit-scope="${s.scope || 'app'}" data-open-skill="${s.id}" data-open-scope="${s.scope || 'app'}">${t('edit')}</button>
    </div>`;
  }).join('');
}

function bindSkillDrag(container) {
  let dragEl = null;
  container.ondragstart = (e) => {
    dragEl = e.target.closest('.skill-li');
    if (!dragEl) return;
    dragEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  };
  container.ondragend = () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
  };
  container.ondragover = (e) => {
    e.preventDefault();
    const over = e.target.closest('.skill-li');
    if (!over || !dragEl || over === dragEl) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    container.insertBefore(dragEl, before ? over : over.nextSibling);
  };
  container.ondrop = async (e) => {
    e.preventDefault();
    const order = [...container.querySelectorAll('.skill-li')].map((el) => ({
      id: el.getAttribute('data-id'),
      scope: el.getAttribute('data-scope')
    }));
    state.skills = await api.reorderSkills(order);
    renderSidebar();
    const modalList = $('m-skill-list');
    if (modalList) {
      modalList.innerHTML = skillListHtml(state.skills);
      bindSkillDrag(modalList);
    }
  };
}

function renderSidebar() {
  $('snap-list').innerHTML = state.snapshots.length
    ? state.snapshots.map((s) => `<button class="side-item" data-restore="${s.id}">${escapeHtml(s.label)}<br><span class="desc">${new Date(s.createdAt).toLocaleString()} · ${t('filesCount', { n: s.changes?.length || 0 })}</span></button>`).join('')
    : `<div class="hint">${t('noSnaps')}</div>`;
  $('skill-list').innerHTML = skillListHtml(state.skills);
  bindSkillDrag($('skill-list'));
  $('persona-list').innerHTML = personaListHtml();
  $('rule-list').innerHTML = ruleListHtml();
}

async function loadFileTree() {
  if (!state.workspace) {
    $('tree-root-name').textContent = t('noProject');
    $('tree-body').innerHTML = `<div class="hint" style="padding:8px">${t('openProjectFirst')}</div>`;
    return;
  }
  $('tree-root-name').textContent = (state.workspace.split(/[\\/]/).pop() || t('project')).toUpperCase();
  const keys = new Set(['.']);
  for (const rel of state.treeOpen) keys.add(rel);
  const next = {};
  for (const key of keys) {
    const rel = key === '.' ? '' : key;
    try {
      next[key] = await api.listChildren(rel);
    } catch {
      next[key] = [];
    }
  }
  state.treeCache = next;
  renderFileTree();
}

async function refreshUiKeepChat() {
  await refreshMeta();
  if (state.previewPath) {
    try { await openCodePreview(state.previewPath); } catch { closeCodePreview(); }
  }
}

function renderFileTree() {
  $('tree-body').innerHTML = renderTreeNodes('', 0) || `<div class="hint" style="padding:8px">${t('emptyDir')}</div>`;
}

function renderTreeNodes(rel, depth) {
  const key = rel || '.';
  const items = state.treeCache[key] || [];
  return items.map((it) => {
    const pad = 8 + depth * 12;
    if (it.dir) {
      const open = state.treeOpen.has(it.path);
      const kids = open ? renderTreeNodes(it.path, depth + 1) : '';
      return `<div>
        <button class="tree-row" style="padding-left:${pad}px" data-tree-dir="${encodeURIComponent(it.path)}">
          <span class="tree-arrow">${open ? '▾' : '▸'}</span>
          <span class="tree-name">${escapeHtml(it.name)}</span>
        </button>
        ${kids}
      </div>`;
    }
    return `<button class="tree-row ${state.previewPath === it.path ? 'on' : ''}" style="padding-left:${pad}px" data-tree-file="${encodeURIComponent(it.path)}">
      <span class="tree-arrow"> </span>
      <span class="tree-name">${escapeHtml(it.name)}</span>
    </button>`;
  }).join('');
}

async function testConnection(cfg) {
  try {
    const r = await api.testModel(cfg);
    if (r.models?.length) alert(t('modelsAvailable', { list: r.models.join(', ') }));
    else if (r.name) alert(t('modelOk', { name: r.name }));
    else alert(t('connOk'));
  } catch (e) {
    alert(e.message || e);
  }
}

async function refreshLocalFiles() {
  const r = await api.listLocalModels();
  state.modelsDir = r.dir || state.modelsDir;
  state.localFiles = r.files || [];
  return r;
}

async function selectLocalGguf(name) {
  const file = (state.localFiles || []).find((f) => f.name === name);
  let local = state.models.find((m) => m.id === 'local-gguf') || state.models.find((m) => m.type === 'local');
  if (!local) {
    local = { id: 'local-gguf', name: t('localModel'), type: 'local', model: name, modelPath: file?.path || '', vision: false };
    state.models.unshift(local);
  } else {
    local.id = 'local-gguf';
    local.name = local.name || t('localModel');
    local.type = 'local';
    local.model = name;
    local.modelPath = file?.path || '';
    delete local.baseUrl;
    delete local.apiKey;
  }
  state.currentModelId = local.id;
  await api.saveModels(state.models, local.id);
  renderModelMenu();
}

function renderModelMenu() {
  $('btn-model').textContent = currentModel()?.model || t('model');
  const locals = (state.localFiles || []).map((f) => {
    const on = currentModel()?.type === 'local' && (currentModel()?.model === f.name || currentModel()?.modelPath === f.path);
    return `<div class="model-row ${on ? 'on' : ''}">
      <button class="pick" data-gguf="${encodeURIComponent(f.name)}">${on ? '✓ ' : ''}${t('local')} · ${escapeHtml(f.name)}</button>
      <button class="mtest" data-test-gguf="${encodeURIComponent(f.path)}" title="${t('test')}">${t('test')}</button>
    </div>`;
  }).join('');
  const apis = state.models.filter((m) => m.type !== 'local').map((m) => {
    const on = m.id === state.currentModelId;
    return `<div class="model-row ${on ? 'on' : ''}">
      <button class="pick" data-model="${m.id}">${on ? '✓ ' : ''}${escapeHtml(m.name)} · ${escapeHtml(m.model)}</button>
      <button class="mtest" data-test-model="${m.id}" title="${t('testConn')}">${t('test')}</button>
    </div>`;
  }).join('');
  $('model-menu').innerHTML = (locals || `<button disabled>${t('noLocalGguf')}</button>`)
    + (apis ? `<div class="sep"></div>${apis}` : '')
    + `<div class="sep"></div><button data-act="settings">${t('manageModels')}</button>`;
  $('status-model').textContent = modelLabel();
}

function persistSession() {
  if (!state.autoSave) return Promise.resolve();
  const tab = activeSession();
  if (!tab) return Promise.resolve();
  if (!tab.messages?.length) return Promise.resolve();
  return api.saveSession({
    id: tab.id,
    title: tab.title,
    workspace: tab.workspace || state.workspace,
    messages: tab.messages,
    undone: tab.undone || [],
    context: tab.context || emptyContext(),
    updatedAt: new Date().toISOString()
  });
}

function closeCodePreview() {
  state.previewPath = '';
  $('code-preview').classList.add('hidden');
  $('preview-path').textContent = t('noFile');
  $('preview-body').innerHTML = '';
  if (state.workspace) renderFileTree();
}

async function openCodePreview(rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath) return;
  state.previewPath = filePath;
  $('code-preview').classList.remove('hidden');
  $('preview-path').textContent = filePath;
  $('preview-path').title = filePath;
  $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${t('loading')}</div>`;
  renderFileTree();
  try {
    const data = await api.readWorkspaceFile(filePath);
    if (data.kind === 'image') {
      $('preview-body').innerHTML = `<img src="${data.content}" alt="${escapeHtml(data.name)}" data-zoom-src="${data.content}">`;
      return;
    }
    if (data.kind === 'document') {
      const imgs = (data.images || []).map((img) =>
        `<img class="preview-doc-img" src="${img.dataUrl}" alt="${escapeHtml(img.name || '')}" data-zoom-src="${img.dataUrl}">`
      ).join('');
      const lines = String(data.content || '').split('\n');
      $('preview-body').innerHTML = `${imgs}<ol class="code-ol">${lines.map((line) => `<li>${escapeHtml(line) || ' '}</li>`).join('')}</ol>`;
      return;
    }
    if (data.kind === 'binary') {
      $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${t('binaryNoPreview')}</div>`;
      return;
    }
    const lines = String(data.content || '').split('\n');
    $('preview-body').innerHTML = `<ol class="code-ol">${lines.map((line) => `<li>${escapeHtml(line) || ' '}</li>`).join('')}</ol>`;
  } catch (e) {
    $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${escapeHtml(e.message || e)}</div>`;
  }
}

function addContextPath(rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath || state.contextPaths.includes(filePath)) return;
  state.contextPaths.push(filePath);
  renderChips();
}

async function applyRename(id, title) {
  const name = String(title || '').trim().slice(0, 80) || t('unnamed');
  const tab = state.tabs.find((t) => t.id === id);
  if (tab) {
    tab.title = name;
    renderTabs();
    await api.saveSession({
      id: tab.id,
      title: tab.title,
      workspace: tab.workspace || state.workspace,
      messages: tab.messages,
      undone: tab.undone || [],
      context: tab.context || emptyContext()
    });
  } else {
    await api.renameSession(id, name);
  }
}

function promptRename(id, current, onDone) {
  openModal(`<h3>${t('renameTab')}</h3>
    <label>${t('titleLabel')}</label>
    <input id="m-title" value="${escapeHtml(current || '')}" maxlength="80">
    <div class="modal-actions">
      <button type="button" id="m-cancel">${t('cancel')}</button>
      <button type="button" class="primary" id="m-ok">${t('save')}</button>
    </div>`);
  const input = $('m-title');
  input.focus();
  input.select();
  const save = async () => {
    await applyRename(id, input.value);
    if (onDone) onDone();
    else closeModal();
  };
  $('m-cancel').onclick = () => { if (onDone) onDone(); else closeModal(); };
  $('m-ok').onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); if (onDone) onDone(); else closeModal(); }
  };
}

async function openHistorySession(id) {
  await persistSession();
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    closeModal();
    showChat();
    await switchToTab(id);
    return;
  }
  const data = await api.loadSession(id);
  if (data.workspace && data.workspace !== state.workspace) {
    const ws = await api.setWorkspace(data.workspace);
    setWorkspace(ws || data.workspace);
    await refreshMeta();
  }
  const tab = {
    id: data.id,
    title: data.title || t('unnamed'),
    messages: data.messages || [],
    workspace: data.workspace || state.workspace,
    undone: data.undone || [],
    context: data.context || emptyContext()
  };
  state.tabs.push(tab);
  state.activeTab = data.id;
  applyTabContext(tab);
  closeModal();
  showChat();
  renderTabs();
  renderMessages();
}

async function deleteConversation(id, title) {
  const name = title || state.tabs.find((tab) => tab.id === id)?.title || t('unnamed');
  if (!confirm(t('deleteChatConfirm', { name }))) return false;
  await api.deleteSession(id);
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeTab === id) state.activeTab = state.tabs[0]?.id || null;
  if (!state.tabs.length) newTab();
  renderTabs();
  renderMessages();
  return true;
}

async function openHistory() {
  const items = await api.loadSessions();
  const list = items.length
    ? `<div class="hist-ul">${items.map((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
      const wsName = s.workspace ? String(s.workspace).split(/[\\/]/).pop() : '';
      return `<div class="hist-li">
        <button type="button" class="hist-open" data-sid="${s.id}">
          ${escapeHtml(s.title || t('unnamed'))}
          <span class="desc">${escapeHtml([when, wsName].filter(Boolean).join(' · '))}</span>
        </button>
        <button type="button" class="hist-rename" data-rename="${s.id}">${t('rename')}</button>
        <button type="button" class="hist-del" data-del="${s.id}">${t('delete')}</button>
      </div>`;
    }).join('')}</div>`
    : `<p class="hint">${t('noHistory')}</p>`;
  openModal(`<h3>${t('historyTitle')}</h3>${list}<div class="modal-actions"><button type="button" class="primary" id="m-ok">${t('close')}</button></div>`);
  $('modal-card').classList.add('wide');
  $('m-ok').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('modal-card').onclick = async (e) => {
    const delId = e.target.closest('[data-del]')?.getAttribute('data-del');
    if (delId) {
      const cur = items.find((x) => x.id === delId);
      try {
        const ok = await deleteConversation(delId, cur?.title || '');
        if (ok) openHistory();
      } catch (err) {
        alert(err.message || err);
      }
      return;
    }
    const renameId = e.target.closest('[data-rename]')?.getAttribute('data-rename');
    if (renameId) {
      const cur = items.find((x) => x.id === renameId);
      promptRename(renameId, cur?.title || '', () => openHistory());
      return;
    }
    const sid = e.target.closest('[data-sid]')?.getAttribute('data-sid');
    if (!sid) return;
    try {
      await openHistorySession(sid);
    } catch (err) {
      alert(err.message || err);
    }
  };
}

function updateUndoRedo() {
  const tab = activeSession();
  const canUndo = !!(tab && tab.messages.some((m) => m.role === 'user'));
  const canRedo = !!(tab && tab.undone && tab.undone.length);
  if ($('btn-undo')) $('btn-undo').disabled = !canUndo || state.sending;
  if ($('btn-redo')) $('btn-redo').disabled = !canRedo || state.sending;
}

async function undoTurn() {
  if (state.sending) return;
  const tab = activeSession();
  if (!tab?.messages?.length) return;
  let i = tab.messages.length - 1;
  while (i >= 0 && tab.messages[i].role !== 'user') i--;
  if (i < 0) return;
  const removed = tab.messages.splice(i);
  const snapId = [...removed].reverse().find((m) => m.snapshotId)?.snapshotId || null;
  if (snapId) {
    try {
      await api.undoSnapshot(snapId);
    } catch (e) {
      alert(e.message || e);
    }
  }
  tab.undone = tab.undone || [];
  tab.undone.push({ messages: removed, snapshotId: snapId });
  renderMessages();
  persistSession();
  await refreshAfterRestore();
}

async function redoTurn() {
  if (state.sending) return;
  const tab = activeSession();
  if (!tab?.undone?.length) return;
  const item = tab.undone.pop();
  if (item.snapshotId) {
    try {
      await api.redoSnapshot(item.snapshotId);
    } catch (e) {
      alert(e.message || e);
    }
  }
  tab.messages.push(...(item.messages || []));
  renderMessages();
  persistSession();
  await refreshAfterRestore();
}

function forkAt(index) {
  const tab = activeSession();
  if (!tab) return;
  const slice = tab.messages.slice(0, index + 1).map((m) => JSON.parse(JSON.stringify(m)));
  const forked = {
    id: uid(),
    title: `${(tab.title || t('chat')).replace(/ 分叉$/, '').replace(/ fork$/i, '')}${t('forkSuffix')}`,
    messages: slice,
    workspace: state.workspace,
    undone: [],
    context: { skillId: tab.context?.skillId || null, contextPaths: [...(tab.context?.contextPaths || [])], attachments: [...(tab.context?.attachments || [])] }
  };
  state.tabs.push(forked);
  state.activeTab = forked.id;
  renderTabs();
  renderMessages();
  persistSession();
}

function isStopError(e) {
  const m = String(e?.message || e || '');
  return state.aborting || e?.name === 'AbortError' || /已停止|aborted/i.test(m);
}

/** 停止后把原文、图片附件、引用和技能写回输入框，并撤掉未完成的这一轮 */
function refillDraft(draft) {
  if (!draft) return;
  $('input').value = draft.text || '';
  state.skillId = draft.skillId || null;
  state.contextPaths = Array.isArray(draft.contextPaths) ? [...draft.contextPaths] : [];
  state.attachments = Array.isArray(draft.attachments)
    ? draft.attachments.filter((a) => a && a.path).map((a) => ({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() }))
    : [];
  renderChips();
  $('input').focus();
}

function restoreAbortedTurn(tab, draft, titleBefore) {
  if (tab?.messages?.length >= 2) {
    const last = tab.messages[tab.messages.length - 1];
    const prev = tab.messages[tab.messages.length - 2];
    if (last?.role === 'assistant' && prev?.role === 'user') tab.messages.splice(-2, 2);
  }
  if (tab && titleBefore != null) tab.title = titleBefore;
  $('input').value = draft.text || '';
  state.skillId = draft.skillId || null;
  state.contextPaths = [...(draft.contextPaths || [])];
  state.attachments = (draft.attachments || []).map((a) => ({ ...a }));
  renderChips();
  $('input').focus();
}

async function sendOne(text) {
  const tab = activeSession() || (newTab(), activeSession());
  tab.undone = [];
  const draft = {
    text,
    skillId: state.skillId,
    contextPaths: [...state.contextPaths],
    attachments: state.attachments.map((a) => ({ ...a }))
  };
  const titleBefore = tab.title;
  const imageAtts = state.attachments.filter((a) => a.preview);
  const otherAtts = state.attachments.filter((a) => !a.preview);
  tab.messages.push({
    role: 'user',
    text: [text, state.skillId ? `/${state.skillId}` : '', ...state.contextPaths.map((p) => `@${p}`), ...otherAtts.map((a) => a.name)].filter(Boolean).join('\n'),
    images: imageAtts.map((a) => a.preview),
    draft: {
      text,
      skillId: state.skillId,
      contextPaths: [...state.contextPaths],
      attachments: state.attachments.map((a) => ({ path: a.path, name: a.name }))
    }
  });
  if (isNewChatTitle(tab.title) && text) tab.title = text.slice(0, 18);
  const history = tab.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.text }));
  history.pop();
  const assistant = { role: 'assistant', text: '', changes: [], snapshotId: null, thinking: [], status: t('preparing'), thinkingOpen: true };
  tab.messages.push(assistant);
  const payload = {
    text,
    history,
    skillId: state.skillId,
    contextPaths: [...state.contextPaths],
    attachments: [...state.attachments],
    modelId: state.currentModelId
  };
  tab.context = {
    skillId: draft.skillId,
    contextPaths: [...draft.contextPaths],
    attachments: draft.attachments.map((a) => ({ path: a.path, name: a.name }))
  };
  state.skillId = null;
  state.contextPaths = [];
  state.attachments = [];
  renderChips();
  renderTabs();
  renderMessages();
  scrollMessagesToBottom();
  state.aborting = false;
  state.liveAssistant = assistant;
  state.sending = true;
  $('btn-send').textContent = t('stop');
  let aborted = false;
  try {
    const result = await api.chatSend(payload);
    if (isStopError()) {
      flushLivePaint();
      state.liveAssistant = null;
      restoreAbortedTurn(tab, draft, titleBefore);
      aborted = true;
    } else {
      assistant.text = result.text || assistant.text;
      assistant.changes = result.changes || [];
      assistant.snapshotId = result.snapshotId;
      assistant.status = '';
      assistant.thinkingOpen = false;
    }
  } catch (e) {
    if (isStopError(e)) {
      flushLivePaint();
      state.liveAssistant = null;
      restoreAbortedTurn(tab, draft, titleBefore);
      aborted = true;
    } else {
      if (!assistant.text) assistant.text = t('errorPrefix', { msg: e.message || e });
      assistant.status = '';
      assistant.thinkingOpen = false;
    }
  } finally {
    flushLivePaint();
    state.sending = false;
    state.aborting = false;
    state.liveAssistant = null;
    $('btn-send').textContent = t('send');
    renderTabs();
    renderMessages();
    persistSession();
    state.snapshots = await api.listSnapshots();
    renderSidebar();
  }
  return aborted;
}

async function processQueue() {
  const ctx = {
    skillId: state.skillId,
    contextPaths: [...state.contextPaths],
    attachments: state.attachments.map((a) => ({ ...a }))
  };
  while (state.queue.length) {
    const text = state.queue.shift();
    renderQueue();
    state.skillId = ctx.skillId;
    state.contextPaths = [...ctx.contextPaths];
    state.attachments = ctx.attachments.map((a) => ({ ...a }));
    renderChips();
    const aborted = await sendOne(text);
    if (aborted) {
      state.queue = [];
      renderQueue();
      break;
    }
  }
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text && !state.attachments.length && !state.queue.length) return;
  if (!state.workspace) {
    openModal(`<h3>${t('pickWorkspace')}</h3><p class="hint">${t('pickWorkspaceHint')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    $('m-ok').onclick = closeModal;
    return;
  }
  if (!currentModel()) {
    openSettings();
    return;
  }
  if (text) {
    state.queue.push(text);
    input.value = '';
  } else if (state.attachments.length) {
    state.queue.push('');
  }
  renderQueue();
  await processQueue();
}

function pushThink(last, type, text) {
  if (!text) return;
  last.thinking = last.thinking || [];
  const prev = last.thinking[last.thinking.length - 1];
  if (type === 'reason' && prev?.type === 'reason') {
    prev.text += text;
    return;
  }
  if (prev?.text === text) return;
  last.thinking.push({ type, text });
}

function onChatEvent(ev) {
  if (ev.type === 'theme') {
    applyTheme(ev.theme);
    return;
  }
  if (state.aborting) return;
  const tab = activeSession();
  if (!tab) return;
  const last = [...tab.messages].reverse().find((m) => m.role === 'assistant');
  if (!last || last !== state.liveAssistant) return;
  if (ev.type === 'text') {
    last.status = t('generating');
    last.text += ev.text;
    scheduleLivePaint();
  } else if (ev.type === 'status') {
    last.thinkingOpen = true;
    last.status = ev.text;
    scheduleLivePaint();
  } else if (ev.type === 'think' || ev.type === 'reason') {
    last.thinkingOpen = true;
    pushThink(last, ev.type, ev.text);
    scheduleLivePaint();
  } else if (ev.type === 'tool') {
    last.thinkingOpen = true;
    pushThink(last, 'tool', ev.text || `${ev.name || ''} ${ev.detail || ''}`.trim());
    last.status = ev.status === 'running' ? `${t('running')} · ${ev.text}` : '';
    scheduleLivePaint();
  } else if (ev.type === 'files') {
    last.changes = ev.changes;
    last.snapshotId = ev.snapshotId;
    flushLivePaint();
    renderMessages();
    loadFileTree();
  } else if (ev.type === 'done') {
    last.thinkingOpen = false;
    last.status = '';
    if (ev.text) last.text = ev.text;
    flushLivePaint();
    renderMessages();
    } else if (ev.type === 'error') {
    last.status = '';
    last.text = t('errorPrefix', { msg: ev.message || t('unknown') });
    last.thinkingOpen = false;
    flushLivePaint();
    renderMessages();
  }
}

function showSlash(filter) {
  const q = (filter || '').toLowerCase();
  const items = uniqueSkills().filter((s) => !q || s.name.toLowerCase().includes(q) || (s.desc || '').toLowerCase().includes(q));
  const el = $('slash-menu');
  el.classList.remove('hidden');
  el.innerHTML = (items.length
    ? items.map((s) => `<button data-pick-skill="${s.id}"><b>/${escapeHtml(s.name)}</b><div class="desc">${escapeHtml(s.desc)}</div></button>`).join('')
    : `<button disabled>${t('noSkillMatch')}</button>`)
    + `<div class="sep"></div><button data-new-skill="1">${t('skillNew')}</button>`;
}

async function showAt(filter) {
  const files = await api.listFiles(filter || '');
  const el = $('at-menu');
  el.classList.remove('hidden');
  el.innerHTML = files.length
    ? files.slice(0, 40).map((f) => `<button data-pick-file="${encodeURIComponent(f.path)}">${escapeHtml(f.path)}</button>`).join('')
    : `<button disabled>${t('noFileMatch')}</button>`;
}

function onInput() {
  const v = $('input').value;
  const caret = $('input').selectionStart;
  const left = v.slice(0, caret);
  const slash = left.match(/(^|\s)\/([^\s]*)$/);
  const at = left.match(/(^|\s)@([^\s]*)$/);
  if (slash) showSlash(slash[2]);
  else $('slash-menu').classList.add('hidden');
  if (at) showAt(at[2]);
  else $('at-menu').classList.add('hidden');
}

function openClone() {
  openModal(`<h3>${t('cloneTitle')}</h3>
    <label>${t('gitUrl')}</label><input id="m-url" placeholder="https://github.com/user/repo.git" />
    <label>${t('destDir')}</label><input id="m-dest" placeholder="D:\\Projects\\repo" />
    <div class="modal-actions"><button id="m-cancel">${t('cancel')}</button><button class="primary" id="m-ok">${t('clone')}</button></div>`);
  $('m-cancel').onclick = closeModal;
  $('m-ok').onclick = async () => {
    try {
      const dest = await api.cloneRepo({ url: $('m-url').value.trim(), dest: $('m-dest').value.trim() });
      closeModal();
      await openProject(dest);
    } catch (e) {
      alert(e.message || e);
    }
  };
}

function openSsh() {
  openModal(`<h3>${t('sshTitle')}</h3>
    <label>${t('username')}</label><input id="m-user" placeholder="root" />
    <label>${t('host')}</label><input id="m-host" placeholder="192.168.1.10" />
    <label>${t('port')}</label><input id="m-port" value="22" />
    <label>${t('localMap')}</label><input id="m-local" placeholder="${t('localMapPh')}" />
    <p class="hint">${t('sshHint')}</p>
    <div class="modal-actions"><button id="m-cancel">${t('cancel')}</button><button class="primary" id="m-ok">${t('connect')}</button></div>`);
  $('m-cancel').onclick = closeModal;
  $('m-ok').onclick = async () => {
    const profile = {
      user: $('m-user').value.trim(),
      host: $('m-host').value.trim(),
      port: $('m-port').value.trim() || '22',
      localPath: $('m-local').value.trim()
    };
    const r = await api.sshConnect(profile);
    closeModal();
    if (r.workspace) await openProject(r.workspace);
    else openModal(`<h3>SSH</h3><p>${escapeHtml(r.message)}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    if ($('m-ok')) $('m-ok').onclick = closeModal;
  };
}

function openSkillEditor(skill) {
  const isNew = !skill;
  const scope = skill?.scope || (state.workspace ? 'workspace' : 'app');
  const body = skill?.body || `# 新技能\n\n什么时候用：\n\n要怎么做：\n1. \n`;
  openModal(`<div class="modal-card-inner">
    <h3>${isNew ? t('skillNew') : t('skillEdit')}</h3>
    <label>${t('skillName')}</label>
    <input id="m-sid" value="${escapeHtml(skill?.id || '')}" placeholder="${t('skillIdPh')}" />
    <label>${t('scope')}</label>
    <select id="m-scope">
      <option value="app">${t('scopeApp')}</option>
      <option value="workspace"${state.workspace ? '' : ' disabled'}>${t('currentProject')}</option>
    </select>
    <label>${t('skillBody')}</label>
    <textarea id="m-body">${escapeHtml(body)}</textarea>
    <p class="hint">${t('skillHint')}</p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="danger" id="m-del">${t('delete')}</button>`}
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-scope').value = scope;
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-save').onclick = async () => {
    try {
      state.skills = await api.saveSkill({
        id: $('m-sid').value.trim(),
        body: $('m-body').value,
        scope: $('m-scope').value,
        oldId: skill?.id || ''
      });
      renderSidebar();
      $('modal-card').classList.remove('wide');
      closeModal();
    } catch (e) {
      alert(e.message || e);
    }
  };
  if ($('m-del')) {
    $('m-del').onclick = async () => {
      if (!confirm(t('deleteSkillConfirm', { id: skill.id }))) return;
      try {
        state.skills = await api.deleteSkill({ id: skill.id, scope: skill.scope || 'app' });
        if (state.skillId === skill.id) {
          state.skillId = null;
          renderChips();
        }
        renderSidebar();
        $('modal-card').classList.remove('wide');
        closeModal();
      } catch (e) {
        alert(e.message || e);
      }
    };
  }
}

function openSkillManager() {
  openModal(`<h3>${t('manageSkills')}</h3>
    <p class="hint">${t('manageSkillsHint')}</p>
    <div class="skill-ul" id="m-skill-list">${skillListHtml(state.skills)}</div>
    <div class="modal-actions">
      <button id="m-cancel">${t('close')}</button>
      <button class="primary" id="m-new">${t('skillNew')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  bindSkillDrag($('m-skill-list'));
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-new').onclick = () => openSkillEditor(null);
  $('m-skill-list').onclick = (e) => {
    const id = e.target.closest('[data-open-skill]')?.getAttribute('data-open-skill');
    const scope = e.target.closest('[data-open-skill]')?.getAttribute('data-open-scope');
    if (!id) return;
    e.stopPropagation();
    const skill = state.skills.find((s) => s.id === id && (s.scope || 'app') === scope);
    openSkillEditor(skill || { id, scope, body: '', desc: id });
  };
}

function personaListHtml() {
  const p = String(state.persona || '').trim();
  return p
    ? `<button class="side-item" data-edit-persona="1"><b>${t('persona')}</b><br><span class="desc">${escapeHtml(clipText(p, 50))}</span></button>`
    : `<div class="hint">${t('noPersona')}</div>`;
}

function ruleListHtml() {
  return state.rules.length
    ? state.rules.map((r) => `<button class="side-item" data-edit-rule="${escapeHtml(r.id)}" data-edit-rule-scope="${r.scope || 'app'}"><b>${escapeHtml(r.name)}</b> <span class="scope-tag">${r.scope === 'workspace' ? t('scopeProject') : t('scopeGlobal')}</span></button>`).join('')
    : `<div class="hint">${t('noRules')}</div>`;
}

function openPersonaEditor() {
  openModal(`<div class="modal-card-inner">
    <h3>${t('editPersona')}</h3>
    <p class="hint">${t('personaHint')}</p>
    <textarea id="m-persona-body" rows="14">${escapeHtml(state.persona || '')}</textarea>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-save').onclick = async () => {
    const body = $('m-persona-body').value;
    await api.savePersona(body);
    state.persona = body;
    renderSidebar();
    $('modal-card').classList.remove('wide');
    closeModal();
  };
}

function openRuleEditor(rule) {
  const isNew = !rule;
  const scope = rule?.scope || (state.workspace ? 'workspace' : 'app');
  const body = rule?.body || `# 规则名\n\n（写这条规则的内容）\n`;
  openModal(`<div class="modal-card-inner">
    <h3>${isNew ? t('ruleNew') : t('ruleEdit')}</h3>
    <label>${t('ruleName')}</label>
    <input id="m-rid" value="${escapeHtml(rule?.id || '')}" placeholder="${t('ruleIdPh')}" />
    <label>${t('scope')}</label>
    <select id="m-rscope">
      <option value="app">${t('scopeApp')}</option>
      <option value="workspace"${state.workspace ? '' : ' disabled'}>${t('currentProject')}</option>
    </select>
    <label>${t('ruleBodyLabel')}</label>
    <textarea id="m-rbody">${escapeHtml(body)}</textarea>
    <p class="hint">${t('ruleHint')}</p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="danger" id="m-rdel">${t('delete')}</button>`}
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-rsave">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-rscope').value = scope;
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-rsave').onclick = async () => {
    try {
      state.rules = await api.saveRule({
        id: $('m-rid').value.trim(),
        body: $('m-rbody').value,
        scope: $('m-rscope').value,
        oldId: rule?.id || ''
      });
      renderSidebar();
      $('modal-card').classList.remove('wide');
      closeModal();
    } catch (e) {
      alert(e.message || e);
    }
  };
  if ($('m-rdel')) {
    $('m-rdel').onclick = async () => {
      if (!confirm(t('deleteRuleConfirm', { id: rule.id }))) return;
      try {
        state.rules = await api.deleteRule({ id: rule.id, scope: rule.scope || 'app' });
        renderSidebar();
        $('modal-card').classList.remove('wide');
        closeModal();
      } catch (e) {
        alert(e.message || e);
      }
    };
  }
}

function openRuleManager() {
  openModal(`<h3>${t('manageRules')}</h3>
    <div class="side-list" id="m-rule-list">${ruleListHtml()}</div>
    <div class="modal-actions">
      <button id="m-cancel">${t('close')}</button>
      <button class="primary" id="m-new">${t('newRule')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-new').onclick = () => openRuleEditor(null);
  $('m-rule-list').onclick = (e) => {
    const id = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule');
    const scope = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule-scope');
    if (!id) return;
    e.stopPropagation();
    const rule = state.rules.find((r) => r.id === id && (r.scope || 'app') === scope);
    openRuleEditor(rule || { id, scope, body: '' });
  };
}

function openSettings() {
  const rows = state.models.filter((m) => m.type !== 'local').map((m) => `
    <div class="model-row" data-i="${m.id}">
      <div>
        <b>${escapeHtml(m.name)}</b>
        <div class="hint">${escapeHtml(m.baseUrl)} · ${escapeHtml(m.model)}</div>
      </div>
      <div>
        <button data-use="${m.id}">${t('use')}</button>
        <button data-edit="${m.id}">${t('edit')}</button>
        <button data-del="${m.id}">${t('del')}</button>
      </div>
    </div>`).join('');
  openModal(`<h3>${t('settings')}</h3>
    <label>${t('theme')}</label>
    <select id="m-theme">
      <option value="system">${t('themeSystem')}</option>
      <option value="light">${t('themeLight')}</option>
      <option value="dark">${t('themeDark')}</option>
    </select>
    <h3 style="margin-top:16px">${t('localModels')}</h3>
    <p class="hint">${t('localHint')}</p>
    <label>${t('modelsDir')}</label>
    <div class="model-row">
      <div class="hint" id="m-models-dir">${escapeHtml(state.modelsDir || '')}</div>
      <div>
        <button type="button" id="m-download">${t('downloadModel')}</button>
        <button type="button" id="m-pick-dir">${t('pickDir')}</button>
        <button type="button" id="m-open-dir">${t('openDir')}</button>
      </div>
    </div>
    <h3 style="margin-top:16px">${t('apiModels')}</h3>
    ${rows || `<p class="hint">${t('noApiModels')}</p>`}
    <label>${t('name')}</label><input id="m-name" placeholder="OpenAI" />
    <label>${t('apiUrl')}</label><input id="m-url" placeholder="https://api.openai.com/v1" />
    <label>${t('apiKey')}</label><input id="m-key" placeholder="sk-..." />
    <label>${t('modelId')}</label><input id="m-mid" placeholder="gpt-4.1" />
    <h3 style="margin-top:16px">${t('searchSites')}</h3>
    <p class="hint">${t('searchSitesHint')}</p>
    <textarea id="m-sites" class="short" rows="4" placeholder="docs.python.org">${escapeHtml((state.searchSites || []).join('\n'))}</textarea>
    <div class="modal-actions">
      <button id="m-test">${t('testConn')}</button>
      <button id="m-cancel-edit" style="display:none">${t('cancel')}</button>
      <button id="m-add">${t('add')}</button>
      <button class="primary" id="m-ok">${t('done')}</button>
    </div>`);
  $('m-theme').value = state.themePref;
  $('m-theme').onchange = async () => {
    state.themePref = $('m-theme').value;
    applyTheme(await api.setTheme(state.themePref));
  };
  $('m-pick-dir').onclick = async () => {
    const r = await api.pickModelsDir();
    state.modelsDir = r.dir || '';
    state.localFiles = r.files || [];
    $('m-models-dir').textContent = state.modelsDir;
    renderModelMenu();
  };
  $('m-open-dir').onclick = () => api.openModelsDir();
  $('m-download').onclick = () => openDownloader();

  let editingId = null;
  const fillForm = (m) => {
    editingId = m ? m.id : null;
    $('m-name').value = m?.name || '';
    $('m-url').value = m?.baseUrl || '';
    $('m-key').value = m?.apiKey || '';
    $('m-mid').value = m?.model || '';
    $('m-add').textContent = m ? t('saveEdit') : t('add');
    $('m-cancel-edit').style.display = m ? '' : 'none';
  };

  $('modal-card').onclick = async (e) => {
    const use = e.target.closest('[data-use]')?.getAttribute('data-use');
    const edit = e.target.closest('[data-edit]')?.getAttribute('data-edit');
    const del = e.target.closest('[data-del]')?.getAttribute('data-del');
    if (use) {
      state.currentModelId = use;
      await api.saveModels(state.models, state.currentModelId);
      renderModelMenu();
    }
    if (edit) {
      const m = state.models.find((x) => x.id === edit);
      if (m && m.type !== 'local') fillForm(m);
      return;
    }
    if (del) {
      if (del === 'local-gguf') return;
      state.models = state.models.filter((m) => m.id !== del);
      if (state.currentModelId === del) state.currentModelId = state.models[0]?.id || '';
      await api.saveModels(state.models, state.currentModelId);
      renderModelMenu();
      openSettings();
    }
  };
  $('m-cancel-edit').onclick = () => fillForm(null);
  $('m-add').onclick = async () => {
    const name = $('m-name').value.trim();
    const baseUrl = $('m-url').value.trim();
    const apiKey = $('m-key').value.trim();
    const model = $('m-mid').value.trim();
    if (!baseUrl || !model) return alert(t('fillApi'));
    if (editingId && editingId !== 'local-gguf') {
      const target = state.models.find((m) => m.id === editingId);
      if (target) {
        target.name = name || t('customModel');
        target.baseUrl = baseUrl;
        target.apiKey = apiKey;
        target.model = model;
        target.type = 'api';
      }
    } else {
      state.models.push({ id: uid(), name: name || t('customModel'), baseUrl, apiKey, model, type: 'api' });
    }
    await api.saveModels(state.models, state.currentModelId);
    renderModelMenu();
    openSettings();
  };
  $('m-test').onclick = async () => {
    const cfg = {
      type: 'api',
      baseUrl: $('m-url').value.trim(),
      apiKey: $('m-key').value.trim(),
      model: $('m-mid').value.trim()
    };
    if (!cfg.baseUrl) return alert(t('fillUrl'));
    await testConnection(cfg);
  };
  $('m-ok').onclick = async () => {
    const lines = ($('m-sites')?.value || '').split(/\r?\n/);
    try {
      state.searchSites = await api.saveSearchSites(lines);
    } catch (err) {
      alert(err && err.message ? err.message : t('saveFail'));
    }
    closeModal();
  };
}

/* ===== 下载模型：用途 → 本机配置 → 建议 → 下载 ===== */

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return t('unknownSize');
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function fmtSpeed(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.max(0, Math.round(n / 1024))} KB/s`;
}

const PURPOSES = [
  { id: 'code', nameKey: 'purposeCode', descKey: 'purposeCodeDesc' },
  { id: 'chat', nameKey: 'purposeChat', descKey: 'purposeChatDesc' },
  { id: 'image', nameKey: 'purposeImage', descKey: 'purposeImageDesc' },
  { id: 'video', nameKey: 'purposeVideo', descKey: 'purposeVideoDesc' },
  { id: 'manual', nameKey: 'purposeManual', descKey: 'purposeManualDesc' }
];

function openDownloader() {
  state.dl = { taskId: null, purpose: null };
  openModal(`<h3>${t('dlTitle')}</h3>
    <div class="dl-src">${t('dlSource')}<b id="dl-src-name">${t('dlDetecting')}</b>
      <label class="dl-threads">${t('threads')}
        <select id="dl-threads">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4" selected>4</option>
          <option value="8">8</option>
        </select>
      </label>
      <button type="button" id="dl-src-recheck">${t('recheck')}</button>
    </div>
    <div id="dl-body"></div>
    <div id="dl-progress" class="dl-progress hidden">
      <div class="dl-progress-head"><span id="dl-progress-name"></span><button type="button" id="dl-cancel">${t('cancel')}</button></div>
      <div class="dl-bar"><i id="dl-bar-fill"></i></div>
      <div class="hint" id="dl-progress-text"></div>
    </div>
    <div class="modal-actions">
      <button type="button" id="dl-back">${t('backSettings')}</button>
      <button type="button" class="primary" id="dl-close">${t('close')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  $('dl-back').onclick = () => openSettings();
  $('dl-close').onclick = closeModal;
  $('dl-cancel').onclick = () => { if (state.dl.taskId) api.cancelDownload(state.dl.taskId); };
  $('dl-src-recheck').onclick = () => refreshDownloadSource(true);
  renderPurposeStep();
  refreshDownloadSource(false);
}

async function refreshDownloadSource(force) {
  const el = $('dl-src-name');
  if (!el) return;
  el.textContent = t('dlDetecting');
  try {
    const src = await api.downloadSource({ force });
    if (!$('dl-src-name')) return;
    $('dl-src-name').textContent = src.unreachable
      ? t('dlUnreachable')
      : src.name;
  } catch (e) {
    if ($('dl-src-name')) $('dl-src-name').textContent = t('detectFail', { msg: e.message || e });
  }
}

function renderPurposeStep() {
  state.dl.purpose = null;
  $('dl-body').innerHTML = `<p class="hint">${t('dlPurposeHint')}</p>
    <div class="dl-purpose">
      ${PURPOSES.map((p) => `<button type="button" data-purpose="${p.id}"><b>${t(p.nameKey)}</b><span>${t(p.descKey)}</span></button>`).join('')}
    </div>`;
  $('dl-body').onclick = (e) => {
    const purpose = e.target.closest('[data-purpose]')?.getAttribute('data-purpose');
    if (purpose) pickPurpose(purpose);
  };
}

async function pickPurpose(purpose) {
  state.dl.purpose = purpose;
  if (purpose === 'manual') return renderManualStep();
  $('dl-body').innerHTML = `<p class="hint">${t('detectingHw')}</p>`;
  let advice;
  try {
    advice = await api.modelAdvice(purpose);
  } catch (e) {
    $('dl-body').innerHTML = `<p class="hint">${t('detectFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
    return;
  }
  renderAdviceStep(advice);
}

function hardwareHtml(hw) {
  const gpu = hw.gpu?.name
    ? `${escapeHtml(hw.gpu.name)}${hw.gpu.vramGB ? ` · ${t('vram', { n: hw.gpu.vramGB })}` : ` · ${t('vramUnknown')}`}`
    : t('gpuUnknown');
  return `<div class="dl-hw">
    <div><span class="k">${t('cpu')}</span>${t('cpuThreads', { name: escapeHtml(hw.cpu.name), n: hw.cpu.cores })}</div>
    <div><span class="k">${t('mem')}</span>${t('memLine', { total: hw.memTotalGB, free: hw.memFreeGB })}</div>
    <div><span class="k">${t('gpu')}</span>${gpu}</div>
    <div><span class="k">${t('disk')}</span>${t('diskLine', { n: hw.diskFreeGB })}</div>
  </div>`;
}

function renderAdviceStep(advice) {
  const back = `<div class="dl-nav"><button type="button" id="dl-repick">${t('changePurpose')}</button><button type="button" id="dl-goto-manual">${t('searchOrPaste')}</button></div>`;
  if (!advice.supported) {
    $('dl-body').innerHTML = `${hardwareHtml(advice.hardware)}
      <div class="restore-warn">${escapeHtml(advice.reason)}</div>
      <p class="hint">${t('engineNo')}</p>
      ${back}`;
  } else {
    const rows = advice.items.map((m) => {
      const disabled = m.tier === '跑不动' || !m.diskEnough;
      const cls = m.tier === '推荐' ? 'best' : (disabled ? 'weak' : '');
      const tierText = m.tier === '推荐' ? t('tierBest') : (m.tier === '跑不动' ? t('tierNo') : t('tierOk'));
      return `<div class="dl-item ${cls}">
        <div class="dl-item-main">
          <b>${escapeHtml(m.name)}</b><span class="tag">${tierText}</span>
          <div class="hint">${escapeHtml(m.desc)}</div>
          <div class="hint">${t('aboutSizeLine', { n: m.sizeGB, note: escapeHtml(m.note) })}</div>
        </div>
        <button type="button" data-get-repo="${escapeHtml(m.repo)}" data-quant="${escapeHtml(m.quant)}" ${disabled ? 'disabled' : ''}>${t('download')}</button>
      </div>`;
    }).join('');
    $('dl-body').innerHTML = `${hardwareHtml(advice.hardware)}
      <p class="hint">${t('aboutSize')}</p>
      ${rows}${back}`;
  }
  $('dl-body').onclick = async (e) => {
    if (e.target.closest('#dl-repick')) return renderPurposeStep();
    if (e.target.closest('#dl-goto-manual')) return renderManualStep();
    const btn = e.target.closest('[data-get-repo]');
    if (!btn) return;
    await downloadFromRepo(btn.getAttribute('data-get-repo'), btn.getAttribute('data-quant'));
  };
}

function renderManualStep() {
  $('dl-body').innerHTML = `<p class="hint">${t('dlManualHint')}</p>
    <div class="dl-search">
      <input id="dl-q" placeholder="${t('searchPh')}" />
      <button type="button" id="dl-search-btn">${t('search')}</button>
    </div>
    <div id="dl-results"></div>
    <label>${t('pasteUrl')}</label>
    <div class="dl-search">
      <input id="dl-url" placeholder="https://.../xxx.gguf" />
      <button type="button" id="dl-url-btn">${t('download')}</button>
    </div>
    <div class="dl-nav"><button type="button" id="dl-repick">${t('backPurpose')}</button></div>`;
  $('dl-search-btn').onclick = () => searchRepos();
  $('dl-q').onkeydown = (e) => { if (e.key === 'Enter') searchRepos(); };
  $('dl-url-btn').onclick = () => {
    const url = $('dl-url').value.trim();
    if (!/^https?:\/\/.+\.gguf(\?.*)?$/i.test(url)) return alert(t('needGgufUrl'));
    runDownload({ url, name: decodeURIComponent(url.split('?')[0].split('/').pop()) });
  };
  $('dl-body').addEventListener('click', async (e) => {
    if (e.target.closest('#dl-repick')) return renderPurposeStep();
    const repo = e.target.closest('[data-open-repo]')?.getAttribute('data-open-repo');
    if (repo) return openRepoFiles(repo);
    const url = e.target.closest('[data-get-url]')?.getAttribute('data-get-url');
    if (url) {
      const name = e.target.closest('[data-get-url]').getAttribute('data-name');
      await runDownload({ url: decodeURIComponent(url), name });
    }
  });
}

async function searchRepos() {
  const q = $('dl-q').value.trim();
  if (!q) return;
  $('dl-results').innerHTML = `<p class="hint">${t('searching')}</p>`;
  try {
    const { repos } = await api.searchRepos(q);
    if (!$('dl-results')) return;
    $('dl-results').innerHTML = repos.length
      ? repos.map((r) => `<div class="dl-item">
          <div class="dl-item-main"><b>${escapeHtml(r.repo)}</b><div class="hint">${t('downloadsN', { n: r.downloads })}</div></div>
          <button type="button" data-open-repo="${escapeHtml(r.repo)}">${t('viewFiles')}</button>
        </div>`).join('')
      : `<p class="hint">${t('noRepos')}</p>`;
  } catch (e) {
    if ($('dl-results')) $('dl-results').innerHTML = `<p class="hint">${t('searchFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
  }
}

async function openRepoFiles(repo) {
  $('dl-results').innerHTML = `<p class="hint">${t('readingRepo')}</p>`;
  try {
    const { files } = await api.listRepoFiles(repo);
    if (!$('dl-results')) return;
    $('dl-results').innerHTML = `<div class="hint">${escapeHtml(repo)}</div>` + (files.length
      ? files.map((f) => `<div class="dl-item">
          <div class="dl-item-main"><b>${escapeHtml(f.name)}</b><div class="hint">${fmtSize(f.size)}</div></div>
          <button type="button" data-get-url="${encodeURIComponent(f.url)}" data-name="${escapeHtml(f.name)}">${t('download')}</button>
        </div>`).join('')
      : `<p class="hint">${t('noGgufFile')}</p>`);
  } catch (e) {
    if ($('dl-results')) $('dl-results').innerHTML = `<p class="hint">${t('readFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
  }
}

async function downloadFromRepo(repo, quant) {
  setDlStatus(t('confirmingFile'), true);
  try {
    const info = await api.resolveDownload({ repo, quant });
    await runDownload({ url: info.url, name: info.name, size: info.size });
  } catch (e) {
    setDlStatus(t('getFileFail', { msg: e.message || e }), true);
  }
}

function setDlStatus(text, showBox) {
  const box = $('dl-progress');
  if (!box) return;
  if (showBox) box.classList.remove('hidden');
  const txt = $('dl-progress-text');
  if (txt) txt.textContent = text;
}

async function runDownload({ url, name, size }) {
  if (state.dl.taskId) return alert(t('dlBusy'));
  const id = uid();
  state.dl.taskId = id;
  $('dl-progress').classList.remove('hidden');
  $('dl-progress-name').textContent = name;
  $('dl-bar-fill').style.width = '0%';
  setDlStatus(size ? t('dlReadySize', { size: fmtSize(size) }) : t('dlReady'));
  try {
    const res = await api.startDownload({ id, url, name, threads: Number($('dl-threads')?.value) || 4 });
    if (res.ok) {
      state.localFiles = res.files || state.localFiles;
      state.modelsDir = res.dir || state.modelsDir;
      renderModelMenu();
      $('dl-bar-fill').style.width = '100%';
      setDlStatus(res.skipped ? t('dlSkipped') : t('dlDone', { name }));
    } else {
      setDlStatus(res.canceled ? t('dlCanceled') : t('dlFail', { msg: res.message }));
    }
  } catch (e) {
    setDlStatus(t('dlFail', { msg: e.message || e }));
  } finally {
    state.dl.taskId = null;
  }
}

function onDownloadProgress(p) {
  if (!state.dl || p.id !== state.dl.taskId) return;
  const fill = $('dl-bar-fill');
  if (!fill) return;
  const pct = p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
  fill.style.width = `${pct.toFixed(1)}%`;
  const total = p.total > 0 ? fmtSize(p.total) : t('unknown');
  const th = p.threads ? ` · ${p.threads} ${t('threads')}` : '';
  setDlStatus(`${fmtSize(p.downloaded)} / ${total} · ${pct.toFixed(1)}% · ${fmtSpeed(p.speed)}${th}${p.retrying ? ` · ${t('retrying')}` : ''}`);
}

function bind() {
  document.querySelectorAll('.menu-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = btn.parentElement;
      const open = menu.classList.contains('open');
      closeMenus();
      if (!open) menu.classList.add('open');
    };
  });
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('#ctx-menu')) return;
    closeMenus();
  });

  document.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.getAttribute('data-act');
    const path = e.target.closest('[data-path]')?.getAttribute('data-path');
    if (act === 'new-window') api.newWindow();
    if (act === 'open-project') openProject();
    if (act === 'toggle-autosave') {
      state.autoSave = await api.setAutoSave(!state.autoSave);
      $('btn-autosave').querySelector('.check').classList.toggle('on', state.autoSave);
    }
    if (act === 'settings') openSettings();
    if (act === 'manage-skills') openSkillManager();
    if (act === 'edit-persona') openPersonaEditor();
    if (act === 'manage-rules') openRuleManager();
    if (act === 'exit') api.close();
    if (act === 'theme-light' || act === 'theme-dark' || act === 'theme-system') {
      state.themePref = act.replace('theme-', '');
      applyTheme(await api.setTheme(state.themePref));
    }
    if (act === 'about') {
      openModal(`<h3>${t('about')}</h3><p>${t('aboutBody')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
      $('m-ok').onclick = closeModal;
    }
    if (act === 'open-path' && path) openProject(decodeURIComponent(path));
    if (e.target.closest('.recent-item') && path) openProject(decodeURIComponent(path));
  });

  $('btn-min').onclick = () => api.minimize();
  $('btn-max').onclick = () => api.maximize();
  $('btn-close').onclick = () => api.close();
  $('lang-switch').onclick = async (e) => {
    const loc = e.target.closest('[data-locale]')?.getAttribute('data-locale');
    if (!loc || loc === getLocale()) return;
    const saved = await api.setLocale(loc);
    setLocale(saved);
    applyLocaleUi();
  };
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, .menu-drop, .menubar, .lang-switch')) return;
    api.maximize();
  });
  $('btn-open').onclick = () => openProject();
  $('btn-clone').onclick = openClone;
  $('btn-ssh').onclick = openSsh;
  $('btn-view-all').onclick = () => renderRecents(true);

  $('btn-new-tab').onclick = () => { newTab(); renderTabs(); renderMessages(); };
  $('btn-files').onclick = () => {
    state.fileTree = !state.fileTree;
    $('file-tree').classList.toggle('hidden', !state.fileTree);
  };
  $('btn-sidebar').onclick = () => {
    state.sidebar = !state.sidebar;
    $('sidebar').classList.toggle('hidden', !state.sidebar);
  };
  $('tree-body').onclick = async (e) => {
    const dir = e.target.closest('[data-tree-dir]')?.getAttribute('data-tree-dir');
    const file = e.target.closest('[data-tree-file]')?.getAttribute('data-tree-file');
    if (dir) {
      const rel = decodeURIComponent(dir);
      if (state.treeOpen.has(rel)) state.treeOpen.delete(rel);
      else {
        state.treeOpen.add(rel);
        state.treeCache[rel] = await api.listChildren(rel);
      }
      renderFileTree();
      return;
    }
    if (file) {
      const rel = decodeURIComponent(file);
      if (e.ctrlKey) addContextPath(rel);
      else await openCodePreview(rel);
    }
  };
  $('tree-body').oncontextmenu = (e) => {
    const dir = e.target.closest('[data-tree-dir]')?.getAttribute('data-tree-dir');
    const file = e.target.closest('[data-tree-file]')?.getAttribute('data-tree-file');
    const raw = dir || file;
    if (!raw) return;
    showFileCtx(e, decodeURIComponent(raw));
  };
  $('btn-history').onclick = () => openHistory();
  $('btn-more').onclick = openSettings;

  $('tabs').onclick = async (e) => {
    const close = e.target.getAttribute('data-close');
    const id = e.target.closest('.tab')?.getAttribute('data-id');
    if (close) {
      if (state.activeTab === close) await persistSession();
      const wasActive = state.activeTab === close;
      state.tabs = state.tabs.filter((t) => t.id !== close);
      if (!state.tabs.length) newTab();
      if (wasActive) await switchToTab(state.tabs[0].id);
      else {
        renderTabs();
        renderMessages();
      }
      return;
    }
    if (id) await switchToTab(id);
  };
  $('tabs').ondblclick = (e) => {
    if (e.target.closest('[data-close]')) return;
    const id = e.target.closest('.tab')?.getAttribute('data-id');
    if (!id) return;
    const tab = state.tabs.find((t) => t.id === id);
    promptRename(id, tab?.title || '');
  };

  $('btn-attach').onclick = async () => {
    await addAttachments(await api.pickFiles());
  };
  $('btn-mic').onclick = () => {
    openModal(`<h3>${t('voiceTitle')}</h3><p class="hint">${t('voiceHint')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    $('m-ok').onclick = closeModal;
  };
  $('btn-send').onclick = () => {
    if (state.sending) {
      state.aborting = true;
      api.chatAbort();
    } else send();
  };
  $('btn-enqueue').onclick = () => {
    const text = $('input').value.trim();
    if (!text) return;
    state.queue.push(text);
    $('input').value = '';
    $('input').focus();
    renderQueue();
  };
  $('queue').onclick = (e) => {
    const idx = e.target.getAttribute('data-rm-queue');
    if (idx == null) return;
    state.queue.splice(Number(idx), 1);
    renderQueue();
  };
  $('btn-model').onclick = async (e) => {
    e.stopPropagation();
    await refreshLocalFiles();
    renderModelMenu();
    $('model-menu').classList.toggle('show');
  };
  $('model-menu').onclick = async (e) => {
    const testGguf = e.target.closest('[data-test-gguf]')?.getAttribute('data-test-gguf');
    if (testGguf != null) {
      e.stopPropagation();
      await testConnection({ type: 'local', modelPath: decodeURIComponent(testGguf) });
      return;
    }
    const testId = e.target.closest('[data-test-model]')?.getAttribute('data-test-model');
    if (testId != null) {
      e.stopPropagation();
      const m = state.models.find((x) => x.id === testId);
      if (m) await testConnection(m);
      return;
    }
    const ggufName = e.target.closest('[data-gguf]')?.getAttribute('data-gguf');
    const id = e.target.closest('[data-model]')?.getAttribute('data-model');
    if (ggufName) {
      await selectLocalGguf(decodeURIComponent(ggufName));
      return;
    }
    if (id) {
      state.currentModelId = id;
      await api.saveModels(state.models, id);
      renderModelMenu();
    }
  };
  $('chips').onclick = (e) => {
    const img = e.target.closest('.chip-img img');
    if (img && !e.target.closest('button')) {
      openLightbox(img.src);
      return;
    }
    const rm = e.target.getAttribute('data-rm');
    if (rm === 'skill') state.skillId = null;
    if (rm === 'ctx') state.contextPaths = state.contextPaths.filter((p) => p !== decodeURIComponent(e.target.getAttribute('data-p')));
    if (rm === 'att') state.attachments = state.attachments.filter((a) => a.path !== decodeURIComponent(e.target.getAttribute('data-p')));
    renderChips();
  };
  $('slash-menu').onclick = (e) => {
    if (e.target.closest('[data-new-skill]')) {
      $('slash-menu').classList.add('hidden');
      openSkillEditor(null);
      return;
    }
    const id = e.target.closest('[data-pick-skill]')?.getAttribute('data-pick-skill');
    if (!id) return;
    state.skillId = id;
    $('input').value = $('input').value.replace(/(^|\s)\/[^\s]*$/, '$1').trimStart();
    $('slash-menu').classList.add('hidden');
    renderChips();
  };
  $('at-menu').onclick = (e) => {
    const p = e.target.getAttribute('data-pick-file');
    if (!p) return;
    const path = decodeURIComponent(p);
    if (!state.contextPaths.includes(path)) state.contextPaths.push(path);
    $('input').value = $('input').value.replace(/(^|\s)@[^\s]*$/, '$1').trimStart();
    $('at-menu').classList.add('hidden');
    renderChips();
  };
  $('sidebar').onclick = async (e) => {
    const editId = e.target.closest('[data-edit-skill]')?.getAttribute('data-edit-skill');
    const editScope = e.target.closest('[data-edit-skill]')?.getAttribute('data-edit-scope');
    if (editId) {
      const skill = state.skills.find((s) => s.id === editId && (s.scope || 'app') === editScope);
      openSkillEditor(skill || { id: editId, scope: editScope, body: '' });
      return;
    }
    const skill = e.target.closest('[data-skill]')?.getAttribute('data-skill');
    const restore = e.target.closest('[data-restore]')?.getAttribute('data-restore');
    if (skill) { state.skillId = skill; renderChips(); }
    if (restore) {
      const snap = state.snapshots.find((s) => s.id === restore);
      if (!await confirmRestore(snap)) return;
      await api.restoreSnapshot(restore);
      await refreshAfterRestore();
      openModal(`<h3>${t('restored')}</h3><p class="hint">${t('restoredHint')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
      $('m-ok').onclick = closeModal;
    }
  };
  $('btn-new-skill').onclick = () => openSkillEditor(null);
  $('btn-edit-persona').onclick = () => openPersonaEditor();
  $('btn-new-rule').onclick = () => openRuleEditor(null);
  $('persona-list').onclick = (e) => {
    if (e.target.closest('[data-edit-persona]')) openPersonaEditor();
  };
  $('rule-list').onclick = (e) => {
    const id = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule');
    const scope = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule-scope');
    if (!id) return;
    const rule = state.rules.find((r) => r.id === id && (r.scope || 'app') === scope);
    openRuleEditor(rule || { id, scope, body: '' });
  };
  $('messages').addEventListener('toggle', (e) => {
    const el = e.target;
    if (!el.classList?.contains('think-block')) return;
    const tab = activeSession();
    const i = Number(el.getAttribute('data-msg-i'));
    if (!tab?.messages[i]) return;
    tab.messages[i].thinkExpanded = el.open;
    if (el.open) {
      let steps = el.querySelector('.think-steps');
      if (!steps) {
        steps = document.createElement('div');
        steps.className = 'think-steps';
        el.appendChild(steps);
      }
      steps.innerHTML = thinkStepsHtml(tab.messages[i]);
    }
  }, true);
  $('messages').onclick = async (e) => {
    const zoomImg = e.target.closest('img.msg-thumb, img[data-zoom-src]');
    if (zoomImg) {
      openLightbox(zoomImg.src);
      return;
    }
    const refill = e.target.getAttribute('data-refill');
    if (refill != null) {
      const m = activeSession()?.messages?.[Number(refill)];
      if (m?.draft) {
        refillDraft(m.draft);
      } else if (m) {
        $('input').value = m.text || '';
        state.skillId = null;
        state.contextPaths = [];
        state.attachments = [];
        renderChips();
        $('input').focus();
      }
      return;
    }
    const fork = e.target.getAttribute('data-fork');
    if (fork != null) {
      forkAt(Number(fork));
      return;
    }
    if (e.target.closest('[data-expand-files]') || (e.target.closest('.file-card-head') && !e.target.closest('[data-restore]'))) {
      e.target.closest('.file-card')?.classList.toggle('open');
      return;
    }
    const previewFile = e.target.closest('[data-preview-file]')?.getAttribute('data-preview-file');
    if (previewFile) {
      const rel = decodeURIComponent(previewFile);
      await openCodePreview(rel);
      return;
    }
    const reveal = e.target.closest('[data-reveal]')?.getAttribute('data-reveal');
    if (reveal) {
      await revealInFolder(decodeURIComponent(reveal));
      return;
    }
    const id = e.target.closest('[data-restore]')?.getAttribute('data-restore');
    if (!id) return;
    const btn = e.target.closest('[data-restore]');
    const snap = state.snapshots.find((s) => s.id === id) || {
      label: t('thisChange'),
      changes: [...(btn?.closest('.file-card')?.querySelectorAll('[data-preview-file]') || [])]
        .map((el) => ({ path: decodeURIComponent(el.getAttribute('data-preview-file')) }))
    };
    if (!await confirmRestore(snap)) return;
    await api.restoreSnapshot(id);
    if (btn) btn.textContent = t('restored');
    await refreshAfterRestore();
  };
  $('messages').addEventListener('contextmenu', (e) => {
    const previewFile = e.target.closest('[data-preview-file]')?.getAttribute('data-preview-file')
      || e.target.closest('[data-reveal]')?.getAttribute('data-reveal');
    if (!previewFile) return;
    showFileCtx(e, decodeURIComponent(previewFile));
  }, true);
  $('preview-path').oncontextmenu = (e) => {
    if (state.previewPath) showFileCtx(e, state.previewPath);
  };
  document.querySelector('.preview-head').oncontextmenu = (e) => {
    if (e.target.closest('button')) return;
    if (state.previewPath) showFileCtx(e, state.previewPath);
  };
  $('ctx-menu').onclick = (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-ctx="reveal"]') && state.ctxRel) revealInFolder(state.ctxRel);
  };
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.target.closest('#ctx-menu')) return;
    hideCtxMenu();
  });
  $('btn-preview-close').onclick = () => closeCodePreview();
  $('btn-preview-at').onclick = () => {
    if (state.previewPath) addContextPath(state.previewPath);
  };
  $('preview-body').onclick = (e) => {
    const img = e.target.closest('img');
    if (img && img.src) openLightbox(img.src);
  };
  const lb = $('lightbox');
  if (lb) {
    lb.onclick = (e) => { if (e.target === lb) closeLightbox(); };
    $('lightbox-img').onclick = (e) => e.stopPropagation();
    lb.addEventListener('wheel', (e) => {
      if (lb.classList.contains('hidden')) return;
      e.preventDefault();
      const next = e.deltaY < 0 ? lightbox.scale * 1.12 : lightbox.scale / 1.12;
      lightbox.scale = Math.min(8, Math.max(0.2, next));
      applyLightbox();
    }, { passive: false });
    $('lightbox-img').onmousedown = (e) => {
      lightbox.dragging = true;
      lightbox.sx = e.clientX;
      lightbox.sy = e.clientY;
      lightbox.ox = lightbox.x;
      lightbox.oy = lightbox.y;
      e.preventDefault();
    };
    window.addEventListener('mousemove', (e) => {
      if (!lightbox.dragging) return;
      lightbox.x = lightbox.ox + (e.clientX - lightbox.sx);
      lightbox.y = lightbox.oy + (e.clientY - lightbox.sy);
      applyLightbox();
    });
    window.addEventListener('mouseup', () => { lightbox.dragging = false; });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) {
      e.preventDefault();
      closeLightbox();
    }
  });
  $('input').addEventListener('input', onInput);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('paste', async (e) => {
    if ($('view-chat').classList.contains('hidden')) return;
    if (e.target.closest('.modal')) return;
    const native = api.clipboardPasteSync() || { kind: 'none', files: [] };
    const items = [...(e.clipboardData?.items || [])];
    const hasEventFile = (e.clipboardData?.files && e.clipboardData.files.length)
      || items.some((it) => it.kind === 'file' || String(it.type || '').startsWith('image/'));
    const text = (e.clipboardData?.getData('text/plain') || '').trim();
    const useNativeFiles = native.kind === 'files' && native.files?.length;
    const useNativeImage = !hasEventFile && !text && native.kind === 'image' && native.files?.length;
    if (!hasEventFile && !useNativeFiles && !useNativeImage) return;
    e.preventDefault();
    try {
      const fromEvent = hasEventFile ? await attachmentsFromPasteEvent(e) : [];
      const fromNative = (useNativeFiles || useNativeImage) ? (native.files || []) : [];
      await addAttachments([...fromEvent, ...fromNative]);
    } catch (err) {
      alert(err.message || err);
    }
  });
  const composer = $('composer');
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('drop-on');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop-on'));
  composer.addEventListener('drop', async (e) => {
    e.preventDefault();
    composer.classList.remove('drop-on');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    try {
      const list = [];
      for (const f of files) list.push(await fileToAttachment(f));
      await addAttachments(list);
    } catch (err) {
      alert(err.message || err);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      e.preventDefault();
      refreshUiKeepChat();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); }
    const inInput = e.target && (e.target.id === 'input' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (inInput && e.target.value) return;
      e.preventDefault();
      undoTurn();
    }
    if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
      if (inInput && e.target.id === 'input' && e.target.value && e.key.toLowerCase() === 'y') return;
      e.preventDefault();
      redoTurn();
    }
  });
}

api.onChatEvent(onChatEvent);
api.onWorkspaceChanged(() => {
  loadFileTree();
  if (state.previewPath) {
    openCodePreview(state.previewPath).catch(() => closeCodePreview());
  }
});
api.onUiRefresh(() => { refreshUiKeepChat(); });
api.onDownloadProgress(onDownloadProgress);

(async function init() {
  bind();
  const s = await api.getState();
  setLocale(s.locale || 'zh');
  applyDom();
  state.themePref = s.theme;
  state.autoSave = s.autoSave;
  state.recents = s.recents || [];
  state.models = s.models || [];
  state.currentModelId = s.currentModelId;
  state.modelsDir = s.modelsDir || '';
  state.searchSites = s.searchSites || [];
  state.localFiles = s.localFiles || [];
  $('btn-autosave').querySelector('.check').classList.toggle('on', state.autoSave);
  applyTheme(s.resolvedTheme);
  setWorkspace(s.workspace);
  renderRecents();
  renderModelMenu();
  state.skills = await api.listSkills();
  state.persona = (await api.loadPersona()) || '';
  if (s.workspace) {
    await refreshMeta();
    await restoreLastSession(s.workspace);
    showChat();
    renderTabs();
    renderMessages();
  } else {
    showWelcome();
  }
})();

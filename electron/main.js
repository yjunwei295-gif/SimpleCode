const {
  app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, shell, crashReporter
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const store = require('./lib/store');
const snapshot = require('./lib/snapshot');
const agent = require('./lib/agent');
const skillsLib = require('./lib/skills');
const localLlm = require('./lib/local-llm');
const diag = require('./lib/diag');
const downloader = require('./lib/downloader');
const hardware = require('./lib/hardware');
const assembly = require('./lib/assembly');
const { migrateUserData } = require('./lib/migrate-userdata');
const mmprojLib = require('./lib/mmproj');
const visionEngine = require('./lib/vision-engine');
const { parseAttachment, isDocumentExt } = require('./lib/media');
const { listTree, listChildren, readForPreview, safeJoin, SKIP } = require('./lib/workspace');

const APP_ROOT = path.join(__dirname, '..');
const windows = new Set();
const workspaceByWin = new WeakMap();
const abortByWin = new WeakMap();
const watchByWin = new WeakMap();

// 视觉代理启动状态（主进程内记录，重启后重新按需启动）
let visionStarted = false;
let visionStartError = '';

function sessionDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    icon: path.join(APP_ROOT, 'icons.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  windows.add(win);
  workspaceByWin.set(win, '');
  win.on('closed', () => {
    diag.log('window', '窗口已关闭');
    stopWorkspaceWatch(win);
    windows.delete(win);
  });
  win.on('unresponsive', () => diag.log('window', '窗口无响应'));
  win.on('responsive', () => diag.log('window', '窗口恢复响应'));
  win.webContents.on('render-process-gone', (_e, details) => diag.log('crash', '渲染进程退出', details));
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    diag.log('crash', 'preload 出错', { preloadPath, message: error && error.message });
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault();
      sendTo(win, 'ui:refresh', {});
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

function getWin(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

function settingsWithTheme() {
  const s = store.load();
  return { ...s, resolvedTheme: store.resolveTheme(s.theme) };
}

function stopWorkspaceWatch(win) {
  const rec = watchByWin.get(win);
  if (!rec) return;
  try { rec.watcher.close(); } catch { /* 忽略 */ }
  if (rec.timer) clearTimeout(rec.timer);
  watchByWin.delete(win);
}

function watchIsNoise(filename) {
  if (!filename) return true;
  const parts = String(filename).split(/[\\/]/);
  return parts.some((p) => SKIP.has(p) || p === '.sinpo' || p === '.simple' || (p.startsWith('.') && p !== '.'));
}

function startWorkspaceWatch(win, dir) {
  stopWorkspaceWatch(win);
  if (!dir || !fs.existsSync(dir)) return;
  try {
    const rec = { watcher: null, timer: null };
    rec.watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
      if (watchIsNoise(filename)) return;
      if (rec.timer) return;
      rec.timer = setTimeout(() => {
        rec.timer = null;
        sendTo(win, 'workspace:changed', {});
      }, 300);
    });
    rec.watcher.on('error', () => stopWorkspaceWatch(win));
    watchByWin.set(win, rec);
  } catch {
    /* 当前盘不支持递归监听时，仍靠工具改文件后的刷新 */
  }
}

function addRecent(dir) {
  const s = store.load();
  const name = path.basename(dir);
  s.recents = [{ name, path: dir, openedAt: Date.now() }, ...s.recents.filter((r) => r.path !== dir)].slice(0, 20);
  store.save(s);
}

// 崩溃诊断：闪退时窗口和控制台一起消失，只能靠这份日志回溯
// 本地留存崩溃转储，用来区分「原生崩溃」和「被外部杀掉」
crashReporter.start({ submitURL: '', uploadToServer: false, compress: false });

try {
  const mig = migrateUserData();
  if (mig.copied) console.log(`[migrate] 已从 ${mig.from} 迁到 ${mig.to}`);
} catch (e) {
  console.log('[migrate] 迁移失败', e && e.message);
}

diag.log('app', '主进程启动', { pid: process.pid, electron: process.versions.electron, node: process.versions.node });

function crashDumpDir() {
  return path.join(app.getPath('crashDumps'), 'reports');
}

/** 启动时把上次留下的崩溃转储列出来，有转储就说明上次是原生崩溃 */
function reportPreviousCrashes() {
  try {
    const dir = crashDumpDir();
    const dumps = fs.readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.dmp'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    if (!dumps.length) {
      diag.log('crash', '未发现崩溃转储', { dir });
      return;
    }
    for (const d of dumps) {
      diag.log('crash', '发现崩溃转储', { file: path.join(dir, d.name), time: new Date(d.mtime).toLocaleString('zh-CN') });
    }
  } catch {
    diag.log('crash', '崩溃转储目录不存在', { dir: crashDumpDir() });
  }
}

/** 心跳：记录内存曲线，闪退前的最后一条能看出是否内存耗尽 */
function startHeartbeat() {
  setInterval(() => {
    const mem = process.memoryUsage();
    diag.log('heartbeat', '存活', {
      主进程rssMB: Math.round(mem.rss / 1048576),
      堆已用MB: Math.round(mem.heapUsed / 1048576),
      外部内存MB: Math.round((mem.external || 0) / 1048576),
      系统可用MB: Math.round(os.freemem() / 1048576),
      窗口数: windows.size
    });
  }, 5000).unref();
}

process.on('uncaughtException', (err) => {
  diag.log('crash', '主进程未捕获异常', { message: err && err.message, stack: err && err.stack });
});
process.on('unhandledRejection', (err) => {
  diag.log('crash', '主进程未处理的 Promise 拒绝', { message: err && err.message, stack: err && err.stack });
});
process.on('exit', (code) => diag.log('app', '主进程退出', { code }));

app.on('child-process-gone', (_e, details) => diag.log('crash', '子进程退出', details));
app.on('before-quit', () => {
  diag.log('app', '收到退出请求 before-quit');
  downloader.cancelAll();
  try { visionEngine.stop(); } catch { /* 退出时忽略 */ }
});
app.on('will-quit', () => diag.log('app', '即将退出 will-quit'));
app.on('quit', (_e, code) => diag.log('app', '已退出 quit', { code }));

ipcMain.on('log:client', (_e, payload) => {
  diag.log('renderer', (payload && payload.message) || '界面异常', payload && payload.detail);
});

app.whenReady().then(() => {
  diag.log('app', `诊断日志位置：${diag.logFile()}`);
  reportPreviousCrashes();
  startHeartbeat();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  diag.log('app', '所有窗口已关闭');
  if (process.platform !== 'darwin') app.quit();
});

nativeTheme.on('updated', () => {
  const s = store.load();
  if (s.theme === 'system') {
    for (const win of windows) sendTo(win, 'chat:event', { type: 'theme', theme: store.resolveTheme('system') });
  }
});

function modelsDirOf(s) {
  const dir = (s && s.modelsDir) || store.defaultModelsDir();
  return localLlm.ensureDir(dir);
}

ipcMain.handle('app:state', async (e) => {
  const win = getWin(e);
  const s = settingsWithTheme();
  const modelsDir = modelsDirOf(s);
  return {
    ...s,
    modelsDir,
    workspace: workspaceByWin.get(win) || '',
    appRoot: APP_ROOT,
    localFiles: localLlm.listGguf(modelsDir),
    assemblyKey: assembly.assemblyKey(s)
  };
});

ipcMain.handle('app:theme', (_e, theme) => {
  const s = store.load();
  s.theme = theme;
  store.save(s);
  return store.resolveTheme(theme);
});

ipcMain.handle('app:locale', (_e, locale) => {
  const s = store.load();
  s.locale = locale === 'en' ? 'en' : 'zh';
  store.save(s);
  return s.locale;
});

ipcMain.handle('app:searchSites', (_e, sites) => {
  const s = store.load();
  s.searchSites = require('./lib/web-search').normalizeSites(sites);
  store.save(s);
  return s.searchSites;
});

ipcMain.handle('window:new', () => {
  createWindow();
});

ipcMain.handle('window:minimize', (e) => getWin(e)?.minimize());
ipcMain.handle('window:maximize', (e) => {
  const win = getWin(e);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('window:close', (e) => getWin(e)?.close());

ipcMain.handle('workspace:open', async (e) => {
  const win = getWin(e);
  const res = await dialog.showOpenDialog(win, {
    title: '选择工作目录',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  workspaceByWin.set(win, dir);
  addRecent(dir);
  startWorkspaceWatch(win, dir);
  return dir;
});

ipcMain.handle('workspace:set', (e, dir) => {
  const win = getWin(e);
  if (dir && fs.existsSync(dir)) {
    workspaceByWin.set(win, dir);
    addRecent(dir);
    startWorkspaceWatch(win, dir);
    return dir;
  }
  throw new Error('目录不存在');
});

ipcMain.handle('workspace:files', (e, query) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) return [];
  return listTree(ws, { query: query || '', max: 200 });
});

ipcMain.handle('workspace:children', (e, rel) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) return [];
  return listChildren(ws, rel || '');
});

ipcMain.handle('workspace:read', async (e, rel) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未打开项目');
  const abs = safeJoin(ws, rel || '');
  const ext = path.extname(abs).toLowerCase();
  if (isDocumentExt(ext)) {
    const parsed = await parseAttachment(abs);
    return {
      kind: 'document',
      path: String(rel || '').replace(/\\/g, '/'),
      name: parsed.name,
      content: parsed.text || '',
      images: (parsed.images || []).map((img) => ({ name: img.name, dataUrl: img.dataUrl }))
    };
  }
  return readForPreview(ws, rel || '');
});

ipcMain.handle('shell:showInFolder', (e, rel) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未打开项目');
  const abs = safeJoin(ws, rel || '');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle('file:preview', (_e, abs) => {
  if (!abs || !fs.existsSync(abs)) throw new Error('文件不存在');
  const ext = path.extname(abs).toLowerCase();
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  }[ext];
  if (!mime) throw new Error('不是图片');
  const stat = fs.statSync(abs);
  if (stat.size > 8 * 1024 * 1024) throw new Error('图片过大');
  const buf = fs.readFileSync(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('git:clone', async (e, { url, dest }) => {
  if (!url || !dest) throw new Error('请填写仓库地址和目标目录');
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', url, dest], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(0, 800) || `git clone 失败，退出码 ${code}`));
    });
    child.on('error', (er) => reject(new Error('未找到 git，请先安装 Git')));
  });
  const win = getWin(e);
  workspaceByWin.set(win, dest);
  addRecent(dest);
  startWorkspaceWatch(win, dest);
  return dest;
});

ipcMain.handle('ssh:connect', async (e, profile) => {
  const s = store.load();
  s.sshProfiles = [profile, ...(s.sshProfiles || []).filter((p) => p.host !== profile.host)].slice(0, 10);
  store.save(s);
  if (profile.localPath && fs.existsSync(profile.localPath)) {
    const win = getWin(e);
    workspaceByWin.set(win, profile.localPath);
    addRecent(profile.localPath);
    startWorkspaceWatch(win, profile.localPath);
    return { ok: true, workspace: profile.localPath, message: '已打开本地映射目录' };
  }
  const args = ['-p', String(profile.port || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${profile.user}@${profile.host}`, 'echo', 'ok'];
  const result = await new Promise((resolve) => {
    const child = spawn('ssh', args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', () => resolve({ code: -1, err: '未找到 ssh 命令' }));
  });
  if (result.code === 0) {
    return { ok: true, workspace: null, message: 'SSH 连通。请把远程目录同步到本地后，用「打开项目」选择该目录。' };
  }
  return { ok: false, message: result.err || 'SSH 连接失败。第一版请先同步到本地再打开。' };
});

ipcMain.handle('models:save', (_e, { models, currentModelId }) => {
  const s = store.load();
  s.models = store.migrateModels(models);
  s.currentModelId = currentModelId;
  if (!s.models.some((m) => m.id === s.currentModelId)) {
    s.currentModelId = s.models[0]?.id || 'local-gguf';
  }
  store.save(s);
  return true;
});

ipcMain.handle('models:saveAssembly', (_e, { key, slots }) => {
  const s = store.load();
  s.assemblies = s.assemblies && typeof s.assemblies === 'object' ? s.assemblies : {};
  const k = String(key || assembly.assemblyKey(s));
  s.assemblies[k] = { slots: Array.isArray(slots) ? slots : [] };
  assembly.syncVisionFields(s, s.assemblies[k].slots);
  store.save(s);
  return { key: k, slots: s.assemblies[k].slots };
});

// 保存视觉代理配置：本地 GGUF 视觉模型 + mmproj 投影文件 + 可选本地 OpenAI 兼容端点
ipcMain.handle('models:saveVision', (_e, payload) => {
  const s = store.load();
  const p = payload && typeof payload === 'object' ? payload : { model: payload };
  s.visionAgentModel = typeof p.model === 'string' ? p.model : '';
  s.visionAgentMmproj = typeof p.mmproj === 'string' ? p.mmproj : '';
  s.visionAgentEndpoint = typeof p.endpoint === 'string' ? p.endpoint : '';
  const key = assembly.assemblyKey(s);
  s.assemblies = s.assemblies || {};
  if (!s.assemblies[key]) s.assemblies[key] = { slots: [] };
  const slots = s.assemblies[key].slots;
  const idx = slots.findIndex((x) => x.role === 'vision');
  const visionSlot = {
    id: idx >= 0 ? slots[idx].id : `slot-vision-${Date.now()}`,
    role: 'vision',
    type: 'local',
    model: s.visionAgentModel,
    mmproj: s.visionAgentMmproj,
    endpoint: s.visionAgentEndpoint
  };
  if (s.visionAgentModel) {
    if (idx >= 0) slots[idx] = { ...slots[idx], ...visionSlot };
    else slots.push(visionSlot);
  } else if (idx >= 0) {
    slots.splice(idx, 1);
  }
  store.save(s);
  return { model: s.visionAgentModel, mmproj: s.visionAgentMmproj, endpoint: s.visionAgentEndpoint };
});

// 启动本地视觉模型；缺 mmproj 时自动搜/下，并把进度推给当前窗口
ipcMain.handle('models:visionStart', async (e) => {
  const win = getWin(e);
  const s = store.load();
  const vis = assembly.visionFrom(s);
  const model = vis.model || '';
  if (!model) throw new Error('请先在「文件 → 模型组合」中给当前主模型挂上看图模型');
  const file = localLlm.resolveGgufPath({ model, modelPath: '' }, modelsDirOf(s));
  if (!file) throw new Error(`未找到视觉模型文件：${model}。请确认该模型在本地模型目录下。`);
  const en = s.locale === 'en';
  const say = (text, extra) => sendTo(win, 'vision:status', { text, ...(extra || {}) });
  let projector = vis.mmproj || '';
  projector = await mmprojLib.ensure(file, projector, say);
  say(en ? 'Loading vision engine…' : '投影文件已就绪，正在启动看图引擎…');
  try {
    await visionEngine.ensureServer({ modelPath: file, mmproj: projector, onWait: say });
    visionStarted = true;
    visionStartError = '';
    diag.log('vision', '看图引擎已启动', { model, mmproj: projector });
    return { ok: true, model, mmproj: projector };
  } catch (e) {
    visionStarted = false;
    visionStartError = (e && e.message) || String(e);
    diag.log('vision', '看图引擎启动失败', { model, message: visionStartError });
    throw e;
  }
});

ipcMain.handle('models:findMmproj', async (_e, modelName) => {
  const s = store.load();
  const dir = modelsDirOf(s);
  const file = localLlm.resolveGgufPath({ model: modelName, modelPath: '' }, dir);
  if (!file) return { path: '' };
  const found = mmprojLib.findLocal(path.dirname(file), path.basename(file));
  return { path: found || '' };
});

ipcMain.handle('models:visionStatus', () => {
  const s = store.load();
  const vis = assembly.visionFrom(s);
  return {
    started: visionStarted,
    error: visionStartError,
    model: vis.model || '',
    mmproj: vis.mmproj || ''
  };
});

ipcMain.handle('models:test', async (_e, modelCfg) => {
  if (modelCfg?.type === 'local' || (!modelCfg?.baseUrl && (modelCfg?.modelPath || /\.gguf$/i.test(modelCfg?.model || '')))) {
    const s = store.load();
    const file = localLlm.resolveGgufPath(modelCfg, modelsDirOf(s));
    return localLlm.probe(file);
  }
  const url = `${String(modelCfg.baseUrl).replace(/\/$/, '')}/models`;
  const headers = {};
  if (modelCfg.apiKey) headers.Authorization = `Bearer ${modelCfg.apiKey}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('连接超时，请检查接口地址和网络是否可达');
  }
  if (!res.ok) throw new Error(`测试失败 ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const ids = (data.data || []).map((m) => m.id).slice(0, 30);
  return { ok: true, models: ids };
});

ipcMain.handle('models:listLocal', () => {
  const dir = modelsDirOf(store.load());
  return { dir, files: localLlm.listGguf(dir) };
});

ipcMain.handle('models:pickDir', async (e) => {
  const win = getWin(e);
  const s = store.load();
  const res = await dialog.showOpenDialog(win, {
    title: '选择本地模型目录',
    defaultPath: modelsDirOf(s),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return { dir: modelsDirOf(s), files: localLlm.listGguf(modelsDirOf(s)) };
  s.modelsDir = res.filePaths[0];
  store.save(s);
  const dir = localLlm.ensureDir(s.modelsDir);
  return { dir, files: localLlm.listGguf(dir) };
});

ipcMain.handle('models:openDir', async () => {
  const dir = modelsDirOf(store.load());
  await shell.openPath(dir);
  return dir;
});

/* ===== 本机配置检测与模型下载 ===== */

ipcMain.handle('hw:detect', async () => hardware.detect(modelsDirOf(store.load())));

ipcMain.handle('hw:advice', async (_e, purpose) => {
  const hw = await hardware.detect(modelsDirOf(store.load()));
  return { hardware: hw, ...hardware.suggest(purpose, hw) };
});

ipcMain.handle('download:source', async (_e, opts) => downloader.resolveSource(opts || {}));

ipcMain.handle('download:search', async (_e, query) => downloader.searchRepos(query));

ipcMain.handle('download:repoFiles', async (_e, repo) => {
  const { source, files } = await downloader.listRepoFiles(repo);
  return {
    source,
    repo,
    files: files.map((f) => ({ ...f, url: downloader.fileUrl(source.base, repo, f.name) }))
  };
});

/** 把候选模型解析成真实文件：仓库里的文件名会变，所以下载前才去查 */
ipcMain.handle('download:resolve', async (_e, { repo, quant }) => {
  const { source, files } = await downloader.listRepoFiles(repo);
  const picked = downloader.pickFile(files, quant);
  if (!picked) throw new Error(`仓库 ${repo} 里没有找到可用的 gguf 文件`);
  const url = downloader.fileUrl(source.base, repo, picked.name);
  const size = picked.size || await downloader.remoteSize(url);
  return { source, repo, name: picked.name, size, url };
});

ipcMain.handle('download:start', async (e, { id, url, name, threads }) => {
  const win = getWin(e);
  const dir = modelsDirOf(store.load());
  const result = await downloader.download({
    id,
    url,
    dir,
    name,
    threads: Number(threads) || 4,
    onProgress: (p) => sendTo(win, 'download:progress', p)
  });
  return { ...result, files: localLlm.listGguf(dir), dir };
});

ipcMain.handle('download:cancel', (_e, id) => downloader.cancel(id));

function listedSkills(ws) {
  return skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws || '', store.load().skillOrder || []);
}

function touchSkillOrder(payload, { remove } = {}) {
  const s = store.load();
  s.skillOrder = s.skillOrder || [];
  const scope = payload.scope || 'app';
  const id = String(payload.id || '').trim();
  if (remove) {
    s.skillOrder = s.skillOrder.filter((o) => !(o.id === id && (o.scope || 'app') === scope));
  } else {
    if (payload.oldId && payload.oldId !== id) {
      s.skillOrder = s.skillOrder.map((o) => (
        o.id === payload.oldId && (o.scope || 'app') === scope ? { ...o, id } : o
      ));
    }
    if (id && !s.skillOrder.some((o) => o.id === id && (o.scope || 'app') === scope)) {
      s.skillOrder.push({ id, scope });
    }
  }
  store.save(s);
}

ipcMain.handle('skills:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return listedSkills(ws);
});

ipcMain.handle('skills:save', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.saveSkill(APP_ROOT, ws, payload);
  touchSkillOrder(payload);
  return listedSkills(ws);
});

ipcMain.handle('skills:delete', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.deleteSkill(APP_ROOT, ws, payload);
  touchSkillOrder(payload, { remove: true });
  return listedSkills(ws);
});

ipcMain.handle('skills:reorder', (e, order) => {
  const s = store.load();
  s.skillOrder = Array.isArray(order) ? order : [];
  store.save(s);
  const ws = workspaceByWin.get(getWin(e)) || '';
  return listedSkills(ws);
});

ipcMain.handle('rules:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('rules:save', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.saveRule(APP_ROOT, ws, payload);
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('rules:delete', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.deleteRule(APP_ROOT, ws, payload);
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('persona:load', () => skillsLib.loadPersona(APP_ROOT).body);

ipcMain.handle('persona:save', (_e, body) => {
  skillsLib.savePersona(APP_ROOT, body);
  return true;
});

ipcMain.handle('snapshot:list', (e) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) return [];
  return snapshot.list(ws);
});

ipcMain.handle('snapshot:restore', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.restore(ws, id);
});

ipcMain.handle('snapshot:undo', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.undo(ws, id);
});

ipcMain.handle('snapshot:redo', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.redo(ws, id);
});

ipcMain.handle('dialog:files', async (e) => {
  const win = getWin(e);
  const res = await dialog.showOpenDialog(win, {
    title: '选择附件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '全部', extensions: ['*'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: '文档', extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'txt', 'md'] },
      { name: '视频', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

function pasteTempDir() {
  const dir = path.join(app.getPath('temp'), 'simple-paste');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePasteBuffer(name, buf) {
  const safe = String(name || 'clipboard.bin').replace(/[\\/:*?"<>|]/g, '_');
  const dest = path.join(pasteTempDir(), `${Date.now()}-${safe}`);
  fs.writeFileSync(dest, buf);
  return { path: dest, name: path.basename(dest) };
}

function readClipboardFilePaths() {
  const found = [];
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (buf && buf.length) {
      for (const part of buf.toString('ucs2').split('\0')) {
        const p = part.trim();
        if (p && fs.existsSync(p)) found.push(p);
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    const buf = clipboard.readBuffer('CF_HDROP');
    if (buf && buf.length >= 20) {
      const start = buf.readUInt32LE(0);
      const wide = buf.readUInt32LE(16) !== 0;
      const text = wide ? buf.slice(start).toString('ucs2') : buf.slice(start).toString('latin1');
      for (const part of text.split('\0')) {
        const p = part.trim();
        if (p && fs.existsSync(p)) found.push(p);
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    const uri = clipboard.read('text/uri-list') || '';
    for (const line of uri.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      if (!line.toLowerCase().startsWith('file:')) continue;
      let p = decodeURIComponent(line.replace(/^file:\/\//i, ''));
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      p = p.replace(/\//g, path.sep);
      if (p && fs.existsSync(p)) found.push(p);
    }
  } catch {
    /* 忽略 */
  }
  return [...new Set(found)];
}

function collectClipboardAttachments() {
  const paths = readClipboardFilePaths();
  if (paths.length) {
    return { kind: 'files', files: paths.map((p) => ({ path: p, name: path.basename(p) })) };
  }
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    return { kind: 'image', files: [writePasteBuffer('clipboard.png', img.toPNG())] };
  }
  return { kind: 'none', files: [] };
}

ipcMain.on('clipboard:paste-sync', (e) => {
  try {
    e.returnValue = collectClipboardAttachments();
  } catch {
    e.returnValue = [];
  }
});

ipcMain.handle('paste:save', (_e, { name, mime, base64 }) => {
  const buf = Buffer.from(base64 || '', 'base64');
  let fileName = name || 'paste.bin';
  if (!path.extname(fileName)) {
    const ext = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp'
    }[mime] || '.bin';
    fileName += ext;
  }
  return writePasteBuffer(fileName, buf);
});

ipcMain.handle('sessions:list', () => {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      items.push({
        id: data.id,
        title: data.title,
        workspace: data.workspace,
        updatedAt: data.updatedAt,
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0
      });
    } catch {
      /* 忽略损坏会话 */
    }
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return items;
});

ipcMain.handle('sessions:save', (_e, session) => {
  const dir = sessionDir();
  fs.mkdirSync(dir, { recursive: true });
  const data = { ...session, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('sessions:delete', (_e, id) => {
  const p = path.join(sessionDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

ipcMain.handle('sessions:load', (_e, id) => {
  if (!id) throw new Error('会话无效');
  const p = path.join(sessionDir(), `${id}.json`);
  if (!fs.existsSync(p)) throw new Error('会话不存在');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
});

ipcMain.handle('sessions:rename', (_e, { id, title }) => {
  if (!id) throw new Error('会话无效');
  const p = path.join(sessionDir(), `${id}.json`);
  if (!fs.existsSync(p)) throw new Error('会话不存在');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.title = String(title || '').trim().slice(0, 80) || '未命名';
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return { id: data.id, title: data.title };
});

ipcMain.handle('chat:abort', (e) => {
  const c = abortByWin.get(getWin(e));
  if (c) c.abort();
});

ipcMain.handle('chat:send', async (e, payload) => {
  const win = getWin(e);
  const ws = workspaceByWin.get(win);
  const s = store.load();
  const modelCfg = (s.models || []).find((m) => m.id === (payload.modelId || s.currentModelId));
  const ctl = new AbortController();
  abortByWin.set(win, ctl);
  const order = store.load().skillOrder || [];
  const skills = agent.listSkills(APP_ROOT, ws, order);
  const allSkills = skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws, order);
  const skill = payload.skillId ? skills.find((x) => x.id === payload.skillId) : null;
  const rules = agent.listRules(APP_ROOT, ws);
  const onEvent = (ev) => sendTo(win, 'chat:event', ev);
  try {
    const result = await agent.runTurn({
      workspace: ws,
      appRoot: APP_ROOT,
      modelCfg,
      history: payload.history || [],
      userText: payload.text || '',
      attachments: payload.attachments || [],
      contextPaths: payload.contextPaths || [],
      skill,
      rules,
      allSkills,
      onEvent,
      signal: ctl.signal
    });
    return result;
  } catch (err) {
    diag.log('agent', '本轮失败', { message: err && err.message });
    const msg = /No sequences left/i.test(String(err && err.message))
      ? '本地模型上下文占满了。请新开一个对话再试，或把过长的历史清掉。'
      : (err.message || String(err));
    onEvent({ type: 'error', message: msg });
    throw err;
  } finally {
    abortByWin.delete(win);
  }
});

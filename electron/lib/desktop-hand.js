// 虚拟光标与桌面操作。平时慢半拍跟随用户鼠标；接到命令后停住，自己去点、去打字。
const { app, BrowserWindow, screen, desktopCapturer, clipboard } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const diag = require('./diag');

const SIGHT_MAX = 50;
const FOLLOW_MS = 45;
const FOLLOW_BLEND = 0.2;
const CURSOR_GAP = 20;

let alive = false;
let busy = false;
let cursorWin = null;
let followTimer = null;
let vx = null;
let vy = null;
let helper = null;
let helperQueue = Promise.resolve();
let lastLook = { originX: 0, originY: 0, width: 0, height: 0 };

function sightDir() {
  const dir = path.join(app.getPath('userData'), 'ai-sight');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isAlive() {
  return alive;
}

function placeCursor(x, y) {
  if (!cursorWin || cursorWin.isDestroyed()) return;
  // 蓝箭头放在真鼠标右下方，避免透明窗压住鼠标尖导致系统光标消失
  cursorWin.setPosition(Math.round(x) + CURSOR_GAP, Math.round(y) + CURSOR_GAP);
}

function pierceCursor() {
  if (!cursorWin || cursorWin.isDestroyed()) return;
  try { cursorWin.setIgnoreMouseEvents(true, { forward: true }); }
  catch { /* 窗口尚未就绪时忽略，显示后再设一次 */ }
}

function showCursor() {
  if (!alive || !cursorWin || cursorWin.isDestroyed()) return;
  pierceCursor();
  cursorWin.showInactive();
}

function stepFollow() {
  if (!alive || busy) return;
  let point;
  try { point = screen.getCursorScreenPoint(); } catch { return; }
  if (vx == null || vy == null) {
    vx = point.x;
    vy = point.y;
  } else {
    vx += (point.x - vx) * FOLLOW_BLEND;
    vy += (point.y - vy) * FOLLOW_BLEND;
    if (Math.abs(point.x - vx) < 0.6 && Math.abs(point.y - vy) < 0.6) {
      vx = point.x;
      vy = point.y;
    }
  }
  placeCursor(vx, vy);
}

function cursorHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent;overflow:hidden">
<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 3 L4 22 L9 17 L13 25 L16 23 L12 15 L20 15 Z" fill="#2f6fed" stroke="#fff" stroke-width="1.4"/>
</svg></body></html>`;
}

function ensureCursor() {
  if (cursorWin && !cursorWin.isDestroyed()) {
    showCursor();
    return;
  }
  const point = screen.getCursorScreenPoint();
  vx = point.x;
  vy = point.y;
  cursorWin = new BrowserWindow({
    width: 28,
    height: 28,
    x: Math.round(vx) + CURSOR_GAP,
    y: Math.round(vy) + CURSOR_GAP,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  pierceCursor();
  cursorWin.setAlwaysOnTop(true, 'pop-up-menu');
  cursorWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(cursorHtml()));
  cursorWin.once('ready-to-show', showCursor);
  cursorWin.webContents.once('did-finish-load', showCursor);
  cursorWin.on('closed', () => { cursorWin = null; });
}

function hideCursor() {
  try {
    if (cursorWin && !cursorWin.isDestroyed()) cursorWin.hide();
  } catch { /* 退出时窗口可能已经销毁 */ }
}

function stopHelper() {
  if (!helper) return;
  try { helper.stdin.end(); } catch { /* 已经关掉 */ }
  try { helper.kill(); } catch { /* 已经退出 */ }
  helper = null;
  helperQueue = Promise.resolve();
}

function ensureHelper() {
  if (helper && !helper.killed) return helper;
  const script = path.join(__dirname, 'desktop-hand.ps1');
  helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let buf = '';
  const waiters = [];
  helper.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const waiter = waiters.shift();
      if (!waiter) continue;
      if (!line) { waiters.unshift(waiter); continue; }
      try { waiter.resolve(JSON.parse(line)); }
      catch (err) { waiter.reject(err); }
    }
  });
  helper.stderr.on('data', (chunk) => {
    diag.log('desktop', '操作助手报错', { message: String(chunk).slice(0, 300) });
  });
  helper.on('exit', () => { helper = null; });
  helper.request = (payload) => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    helper.stdin.write(JSON.stringify(payload) + '\n');
  });
  return helper;
}

function winInput(payload) {
  const proc = ensureHelper();
  helperQueue = helperQueue.then(() => proc.request(payload)).catch((err) => {
    diag.log('desktop', '操作失败', { message: err && err.message });
    return { ok: false, message: err && err.message ? err.message : '操作失败' };
  });
  return helperQueue;
}

function setAlive(on) {
  alive = !!on;
  if (!alive) {
    busy = false;
    if (followTimer) { clearInterval(followTimer); followTimer = null; }
    hideCursor();
    stopHelper();
    return false;
  }
  ensureCursor();
  const primary = screen.getPrimaryDisplay();
  lastLook = {
    originX: primary.bounds.x,
    originY: primary.bounds.y,
    width: primary.size.width,
    height: primary.size.height
  };
  if (!followTimer) followTimer = setInterval(stepFollow, FOLLOW_MS);
  stepFollow();
  return true;
}

function hold() {
  busy = true;
}

function release() {
  busy = false;
}

function gate() {
  if (!alive) return '「活过来」没开。打开输入栏旁的开关后才能看屏幕和操作鼠标键盘。';
  return '';
}

function toPhysical(x, y) {
  try {
    return screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  } catch {
    return { x: Math.round(x), y: Math.round(y) };
  }
}

async function moveTo(x, y) {
  const denied = gate();
  if (denied) return denied;
  hold();
  vx = Number(x) || 0;
  vy = Number(y) || 0;
  placeCursor(vx, vy);
  return `虚拟光标已移到 (${Math.round(vx)}, ${Math.round(vy)})`;
}

async function clickAt(x, y, button, times) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const sx = lastLook.originX + (Number(x) || 0);
  const sy = lastLook.originY + (Number(y) || 0);
  vx = sx;
  vy = sy;
  placeCursor(vx, vy);
  const phys = toPhysical(sx, sy);
  const res = await winInput({
    op: 'click',
    x: phys.x,
    y: phys.y,
    button: button === 'right' || button === 'middle' ? button : 'left',
    times: Number(times) === 2 ? 2 : 1
  });
  if (!res || res.ok === false) return `点击失败：${(res && res.message) || '未知原因'}`;
  return `已在图内坐标 (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)}) 点击，系统鼠标已放回原处。`;
}

function readPoints(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); }
    catch {
      list = list.split(/[;\n]/).map((part) => {
        const pair = part.split(',');
        return { x: pair[0], y: pair[1] };
      });
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (Array.isArray(p) && p.length >= 2) out.push({ x: Number(p[0]), y: Number(p[1]) });
    else if (p && typeof p === 'object') out.push({ x: Number(p.x), y: Number(p.y) });
  }
  return out.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

async function dragStroke(rawPoints, button) {
  const denied = gate();
  if (denied) return denied;
  const points = readPoints(rawPoints);
  if (points.length < 2) return '拖动至少需要两个图内坐标。画圆请先算出一圈采样点再传入。';
  const used = points.slice(0, 800);
  hold();
  const physical = used.map((p) => {
    const sx = lastLook.originX + p.x;
    const sy = lastLook.originY + p.y;
    return toPhysical(sx, sy);
  });
  const start = used[0];
  const end = used[used.length - 1];
  vx = lastLook.originX + start.x;
  vy = lastLook.originY + start.y;
  placeCursor(vx, vy);
  const res = await winInput({
    op: 'drag',
    button: button === 'right' || button === 'middle' ? button : 'left',
    points: physical
  });
  vx = lastLook.originX + end.x;
  vy = lastLook.originY + end.y;
  placeCursor(vx, vy);
  if (!res || res.ok === false) return `拖动失败：${(res && res.message) || '未知原因'}`;
  const extra = points.length > used.length ? ` 只拖了前 ${used.length} 个点，剩下的请再拖一笔。` : '';
  return `已按住鼠标从 (${Math.round(start.x)}, ${Math.round(start.y)}) 拖到 (${Math.round(end.x)}, ${Math.round(end.y)})，共 ${used.length} 个点，然后松开。系统鼠标已放回原处。${extra}`;
}

async function scrollAt(x, y, delta) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const sx = lastLook.originX + (Number(x) || 0);
  const sy = lastLook.originY + (Number(y) || 0);
  vx = sx;
  vy = sy;
  placeCursor(vx, vy);
  const phys = toPhysical(sx, sy);
  const wheel = Math.max(-2400, Math.min(2400, Math.round(Number(delta) || -120)));
  const res = await winInput({ op: 'scroll', x: phys.x, y: phys.y, delta: wheel });
  if (!res || res.ok === false) return `滚动失败：${(res && res.message) || '未知原因'}`;
  return `已在图内坐标 (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)}) 滚动 ${wheel}。`;
}

async function typeText(text) {
  const denied = gate();
  if (denied) return denied;
  const value = String(text || '');
  if (!value) return '没有要输入的文字';
  hold();
  const image = clipboard.readImage();
  const previous = clipboard.readText();
  const hadImage = image && !image.isEmpty();
  clipboard.writeText(value);
  const res = await winInput({ op: 'key', keys: ['ctrl', 'v'] });
  await new Promise((r) => setTimeout(r, 80));
  try {
    if (hadImage) clipboard.writeImage(image);
    else clipboard.writeText(previous || '');
  } catch { /* 剪贴板被占用时不挡住这次输入 */ }
  if (!res || res.ok === false) return `输入失败：${(res && res.message) || '未知原因'}`;
  return `已向当前焦点窗口粘贴 ${value.length} 个字符。`;
}

async function tapKeys(combo) {
  const denied = gate();
  if (denied) return denied;
  const raw = String(combo || '').trim().toLowerCase();
  if (!raw) return '没有要按的键';
  const keys = raw.split('+').map((s) => s.trim()).filter(Boolean);
  hold();
  const res = await winInput({ op: 'key', keys });
  if (!res || res.ok === false) return `按键失败：${(res && res.message) || '未知原因'}`;
  return `已按下 ${keys.join('+')}。`;
}

function displayUnderPoint(point) {
  const list = screen.getAllDisplays();
  return screen.getDisplayNearestPoint(point) || list[0];
}

function pruneSight(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => {
      const abs = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { mtime = 0; }
      return { abs, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
  while (files.length > SIGHT_MAX) {
    const old = files.shift();
    try { fs.unlinkSync(old.abs); } catch { /* 删不掉就留到下次 */ }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function captionFromVision(text) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('【') && !s.startsWith('看图失败') && !s.includes('没有可用的看图模型'));
  const raw = (line || '画面').replace(/[\\/:*?"<>|\r\n]/g, '').replace(/\s+/g, '').slice(0, 16);
  return raw || '画面';
}

function nameSightFile(abs, visionText) {
  const dir = path.dirname(abs);
  const next = path.join(dir, `${stamp()}-${captionFromVision(visionText)}.png`);
  try {
    if (path.resolve(abs) !== path.resolve(next)) fs.renameSync(abs, next);
  } catch {
    return abs;
  }
  pruneSight(dir);
  return next;
}

async function captureScreen() {
  const denied = gate();
  if (denied) return { ok: false, message: denied };
  hold();
  const point = screen.getCursorScreenPoint();
  const display = displayUnderPoint(point);
  const width = Math.max(1, Math.round(display.size.width));
  const height = Math.max(1, Math.round(display.size.height));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    return { ok: false, message: '没有截到屏幕' };
  }
  const png = source.thumbnail.toPNG();
  const dir = sightDir();
  const abs = path.join(dir, `${stamp()}-画面.png`);
  fs.writeFileSync(abs, png);
  pruneSight(dir);
  lastLook = { originX: display.bounds.x, originY: display.bounds.y, width, height };
  return {
    ok: true,
    path: abs,
    width,
    height,
    originX: display.bounds.x,
    originY: display.bounds.y
  };
}

function importClipboardImage() {
  const denied = gate();
  if (denied) return { ok: false, message: denied };
  hold();
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return { ok: false, message: '剪贴板里没有图片' };
  const dir = sightDir();
  const abs = path.join(dir, `${stamp()}-剪贴板.png`);
  fs.writeFileSync(abs, image.toPNG());
  pruneSight(dir);
  return { ok: true, path: abs, width: image.getSize().width, height: image.getSize().height };
}

module.exports = {
  isAlive, setAlive, hold, release,
  moveTo, clickAt, dragStroke, scrollAt, typeText, tapKeys,
  captureScreen, importClipboardImage, nameSightFile
};

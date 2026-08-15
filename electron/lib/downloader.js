const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const diag = require('./diag');

// 官方站优先；连不上时按顺序回退到镜像
const OFFICIAL = 'https://huggingface.co';
const MIRRORS = ['https://hf-mirror.com'];

const PROBE_TIMEOUT_MS = 6000;
const PROGRESS_INTERVAL_MS = 400;
// 连接卡住不动超过这个时间就重来，避免一直吊着
const IDLE_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 8;

/** 401/403 是源站拒绝，再重试也不会变成 200 */
function isAuthReject(err) {
  return /\b40[13]\b/.test(String(err && err.message || err || ''));
}

let cachedSource = null;
let probing = null;

// 进行中的下载任务：id -> { controller, dest, part }
const tasks = new Map();

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** 探测某个站点的 API 是否可用 */
async function reachable(base) {
  const t = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await net.fetch(`${base}/api/models?limit=1`, { signal: t.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

/**
 * 确定当前可用的下载源：官方通就用官方，不通再依次试镜像
 * @param {{force?: boolean}} [opts] force 为真时忽略缓存重新探测
 */
async function resolveSource(opts = {}) {
  if (cachedSource && !opts.force) return cachedSource;
  if (probing && !opts.force) return probing;
  probing = (async () => {
    if (await reachable(OFFICIAL)) {
      cachedSource = { base: OFFICIAL, name: '官方 HuggingFace', official: true };
    } else {
      cachedSource = null;
      for (const m of MIRRORS) {
        if (await reachable(m)) {
          cachedSource = { base: m, name: `镜像 ${new URL(m).host}`, official: false };
          break;
        }
      }
      if (!cachedSource) {
        cachedSource = { base: OFFICIAL, name: '官方 HuggingFace（探测失败）', official: true, unreachable: true };
      }
    }
    diag.log('download', '下载源探测完成', cachedSource);
    return cachedSource;
  })();
  try {
    return await probing;
  } finally {
    probing = null;
  }
}

async function getJson(url) {
  const t = withTimeout(15000);
  try {
    const res = await net.fetch(url, { signal: t.signal });
    if (!res.ok) throw new Error(`请求失败 ${res.status}`);
    return await res.json();
  } finally {
    t.done();
  }
}

/**
 * 搜索 HuggingFace 上的 GGUF 仓库
 * @param {string} query 关键词
 */
async function searchRepos(query) {
  const src = await resolveSource();
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return { source: src, repos: [] };
  const url = `${src.base}/api/models?search=${q}&filter=gguf&limit=20&sort=downloads&direction=-1`;
  const list = await getJson(url);
  const repos = (Array.isArray(list) ? list : []).map((m) => ({
    repo: m.id || m.modelId || '',
    downloads: m.downloads || 0,
    likes: m.likes || 0
  })).filter((r) => r.repo);
  return { source: src, repos };
}

function isSplitPart(name) {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(name);
}

/**
 * 列出仓库里的 gguf 文件（含体积）。分卷文件会被排除，本地引擎加载不了
 * @param {string} repo 形如 bartowski/Qwen2.5-Coder-7B-Instruct-GGUF
 */
async function listRepoFiles(repo) {
  const src = await resolveSource();
  const info = await getJson(`${src.base}/api/models/${repo}?blobs=true`);
  const files = (info.siblings || [])
    .map((s) => ({ name: s.rfilename, size: s.size || s.lfs?.size || 0 }))
    .filter((f) => {
      const n = f.name.toLowerCase();
      if (/\.mmproj$/i.test(n)) return true;
      if (/\.gguf$/i.test(n) && !isSplitPart(f.name)) return true;
      return false;
    })
    .sort((a, b) => a.size - b.size);
  return { source: src, repo, files };
}

/** 按量化等级从仓库文件里挑一个，挑不到就退回体积最接近的 */
function pickFile(files, quant) {
  const want = String(quant || 'Q4_K_M').toLowerCase();
  return files.find((f) => f.name.toLowerCase().includes(want))
    || files.find((f) => f.name.toLowerCase().includes('q4'))
    || files[0]
    || null;
}

function fileUrl(base, repo, name) {
  return `${base}/${repo}/resolve/main/${encodeURI(name)}`;
}

/** 取远端文件大小，仓库元数据没给体积时用 */
async function remoteSize(url) {
  const t = withTimeout(15000);
  try {
    const res = await net.fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'SimpleCode' }, signal: t.signal });
    const len = Number(res.headers.get('content-length') || 0);
    return Number.isFinite(len) ? len : 0;
  } catch {
    return 0;
  } finally {
    t.done();
  }
}

function safeName(name) {
  return String(name).split(/[\\/]/).pop().replace(/[<>:"|?*]/g, '_');
}

/**
 * 下载一个 gguf 文件到模型目录，支持断点续传
 * @param {object} opts
 * @param {string} opts.id 任务标识，用于取消
 * @param {string} opts.url 直链
 * @param {string} opts.dir 模型目录
 * @param {string} opts.name 保存的文件名
 * @param {(p: object) => void} opts.onProgress 进度回调
 */
/**
 * 单次尝试：从断点续传写入 .part
 * @returns {Promise<{completed: boolean, total: number, downloaded: number}>}
 */
async function attemptOnce({ url, part, userSignal, onChunk }) {
  let downloaded = fs.existsSync(part) ? fs.statSync(part).size : 0;

  // 除了用户取消，卡住不动超过 IDLE_TIMEOUT_MS 也要中断，交给外层重试
  const attemptCtrl = new AbortController();
  const abortByUser = () => attemptCtrl.abort();
  userSignal.addEventListener('abort', abortByUser);
  let idleTimer = null;
  const kickIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => attemptCtrl.abort(), IDLE_TIMEOUT_MS);
  };

  let stream = null;
  try {
    kickIdle();
    const headers = { 'User-Agent': 'SimpleCode' };
    if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;
    const res = await net.fetch(url, { headers, signal: attemptCtrl.signal });
    if (!res.ok && res.status !== 206) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`服务端返回 ${res.status}，该下载源拒绝访问`);
      }
      throw new Error(`服务端返回 ${res.status}`);
    }

    // 服务端不认续传就从头来，避免拼出损坏文件
    const resumed = res.status === 206;
    if (!resumed && downloaded > 0) {
      fs.rmSync(part, { force: true });
      downloaded = 0;
    }
    const remain = Number(res.headers.get('content-length') || 0);
    const total = resumed ? downloaded + remain : remain;

    stream = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kickIdle();
      downloaded += value.length;
      if (!stream.write(Buffer.from(value))) {
        await new Promise((resolve) => stream.once('drain', resolve));
      }
      onChunk(downloaded, total);
    }
    await new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });
    stream = null;
    return { completed: true, total, downloaded };
  } finally {
    clearTimeout(idleTimer);
    userSignal.removeEventListener('abort', abortByUser);
    if (stream) stream.destroy();
  }
}

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(file, meta) {
  fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
}

/** 探测是否支持 Range；不支持就退回单线程 */
async function rangeSupported(url) {
  const t = withTimeout(15000);
  try {
    const res = await net.fetch(url, { headers: { Range: 'bytes=0-0', 'User-Agent': 'SimpleCode' }, signal: t.signal });
    return res.status === 206;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

async function downloadSlice({ url, fd, start, end, got, userSignal, onBytes }) {
  let pos = start + got;
  if (pos > end) return;
  const attemptCtrl = new AbortController();
  const abortByUser = () => attemptCtrl.abort();
  userSignal.addEventListener('abort', abortByUser);
  let idleTimer = null;
  const kickIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => attemptCtrl.abort(), IDLE_TIMEOUT_MS);
  };
  try {
    kickIdle();
    const res = await net.fetch(url, {
      headers: { Range: `bytes=${pos}-${end}`, 'User-Agent': 'SimpleCode' },
      signal: attemptCtrl.signal
    });
    if (res.status !== 206) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`分片返回 ${res.status}，该下载源拒绝访问`);
      }
      throw new Error(`分片返回 ${res.status}，无法续传`);
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kickIdle();
      const buf = Buffer.from(value);
      fs.writeSync(fd, buf, 0, buf.length, pos);
      pos += buf.length;
      onBytes(buf.length);
    }
    if (pos !== end + 1) throw new Error(`分片不完整：写到 ${pos}，期望 ${end + 1}`);
  } finally {
    clearTimeout(idleTimer);
    userSignal.removeEventListener('abort', abortByUser);
  }
}

async function downloadParallel({ id, url, dest, part, metaFile, total, threads, controller, onProgress, fileName }) {
  const parts = [];
  const chunk = Math.ceil(total / threads);
  for (let i = 0; i < threads; i += 1) {
    const start = i * chunk;
    if (start >= total) break;
    const end = Math.min(total, start + chunk) - 1;
    parts.push({ start, end, got: 0 });
  }
  const old = readMeta(metaFile);
  if (old && old.url === url && old.total === total && Array.isArray(old.parts) && old.parts.length === parts.length) {
    for (let i = 0; i < parts.length; i += 1) {
      const g = Number(old.parts[i].got) || 0;
      parts[i].got = Math.min(g, parts[i].end - parts[i].start + 1);
    }
  } else if (fs.existsSync(part) && !old) {
    throw new Error('存在旧的单线程断点，改走单线程续传');
  }

  const fd = fs.openSync(part, fs.existsSync(part) ? 'r+' : 'w+');
  try {
    fs.ftruncateSync(fd, total);
    let lastAt = Date.now();
    let lastBytes = parts.reduce((n, p) => n + p.got, 0);
    const emit = (retrying, attempt) => {
      const downloaded = parts.reduce((n, p) => n + p.got, 0);
      const now = Date.now();
      const speed = (downloaded - lastBytes) / Math.max(0.001, (now - lastAt) / 1000);
      lastAt = now;
      lastBytes = downloaded;
      onProgress?.({ id, downloaded, total, speed, name: fileName, threads, retrying, attempt });
    };
    emit();

    const runAll = async () => {
      await Promise.all(parts.map(async (p, i) => {
        const need = p.end - p.start + 1;
        if (p.got >= need) return;
        await downloadSlice({
          url, fd, start: p.start, end: p.end, got: p.got,
          userSignal: controller.signal,
          onBytes: (n) => {
            p.got += n;
            writeMeta(metaFile, { url, total, threads, parts });
            const now = Date.now();
            if (now - lastAt >= PROGRESS_INTERVAL_MS) emit();
          }
        });
        p.got = need;
        writeMeta(metaFile, { url, total, threads, parts });
      }));
    };

    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) break;
      try {
        await runAll();
        lastErr = null;
        break;
      } catch (err) {
        if (controller.signal.aborted) break;
        lastErr = err;
        diag.log('download', '分片中断，准备重试', { id, attempt, message: err && err.message });
        if (isAuthReject(err) || attempt >= MAX_ATTEMPTS) break;
        emit(true, attempt);
        await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 8000)));
      }
    }
    if (controller.signal.aborted) {
      return { ok: false, canceled: true, message: '已取消下载' };
    }
    if (lastErr) {
      const msg = isAuthReject(lastErr)
        ? (lastErr.message || '下载源拒绝访问')
        : `重试 ${MAX_ATTEMPTS} 次仍失败：${lastErr.message}`;
      return { ok: false, canceled: false, message: msg };
    }
    const finalSize = fs.fstatSync(fd).size;
    if (finalSize !== total) throw new Error(`文件不完整：期望 ${total} 字节，实际 ${finalSize} 字节`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(part, dest);
  fs.rmSync(metaFile, { force: true });
  return { ok: true, path: dest, bytes: total };
}

async function download({ id, url, dir, name, onProgress, threads = 4 }) {
  const fileName = safeName(name);
  const dest = path.join(dir, fileName);
  const part = `${dest}.part`;
  const metaFile = `${dest}.part.meta`;
  if (fs.existsSync(dest)) {
    return { ok: true, path: dest, skipped: true, message: '文件已存在，未重复下载' };
  }
  fs.mkdirSync(dir, { recursive: true });

  const nThreads = Math.max(1, Math.min(8, Number(threads) || 4));
  const controller = new AbortController();
  tasks.set(id, { controller, dest, part });
  diag.log('download', '开始下载', { id, url, dest, threads: nThreads, 已有字节: fs.existsSync(part) ? fs.statSync(part).size : 0 });
  const startedAt = Date.now();

  try {
    let total = await remoteSize(url);
    const canRange = nThreads > 1 && total > 8 * 1024 * 1024 && await rangeSupported(url);
    if (canRange) {
      try {
        const r = await downloadParallel({
          id, url, dest, part, metaFile, total, threads: nThreads, controller, onProgress, fileName
        });
        if (r.ok) {
          diag.log('download', '下载完成', { id, dest, 字节: r.bytes, 耗时秒: Math.round((Date.now() - startedAt) / 1000), threads: nThreads });
          onProgress?.({ id, downloaded: r.bytes, total: r.bytes, speed: 0, name: fileName, threads: nThreads, done: true });
        }
        return r;
      } catch (e) {
        if (!/单线程续传/.test(String(e.message || ''))) {
          diag.log('download', '分片下载失败', { id, message: e.message });
          return { ok: false, canceled: controller.signal.aborted, message: e.message || String(e) };
        }
        diag.log('download', '改走单线程续传', { id, message: e.message });
      }
    }

    let lastAt = 0;
    let lastBytes = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const onChunk = (downloaded, tot) => {
      const now = Date.now();
      if (now - lastAt < PROGRESS_INTERVAL_MS) return;
      const speed = lastAt ? (downloaded - lastBytes) / ((now - lastAt) / 1000) : 0;
      lastAt = now;
      lastBytes = downloaded;
      onProgress?.({ id, downloaded, total: tot, speed, name: fileName, threads: 1 });
    };
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) break;
      try {
        const { completed, total: tot } = await attemptOnce({ url, part, userSignal: controller.signal, onChunk });
        if (!completed) continue;
        const finalSize = fs.statSync(part).size;
        if (tot > 0 && finalSize !== tot) {
          throw new Error(`文件不完整：期望 ${tot} 字节，实际 ${finalSize} 字节`);
        }
        fs.renameSync(part, dest);
        fs.rmSync(metaFile, { force: true });
        diag.log('download', '下载完成', { id, dest, 字节: finalSize, 耗时秒: Math.round((Date.now() - startedAt) / 1000), 尝试次数: attempt });
        onProgress?.({ id, downloaded: finalSize, total: finalSize, speed: 0, name: fileName, done: true });
        return { ok: true, path: dest, bytes: finalSize };
      } catch (err) {
        if (controller.signal.aborted) break;
        lastErr = err;
        const got = fs.existsSync(part) ? fs.statSync(part).size : 0;
        diag.log('download', '下载中断，准备重试', { id, attempt, 已下字节: got, message: err && err.message });
        if (isAuthReject(err) || attempt >= MAX_ATTEMPTS) break;
        onProgress?.({ id, downloaded: got, total: 0, speed: 0, name: fileName, retrying: true, attempt, message: err.message });
        await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 8000)));
        lastAt = 0;
        lastBytes = got;
      }
    }
    const canceled = controller.signal.aborted;
    diag.log('download', canceled ? '下载已取消' : '下载最终失败', { id, message: lastErr && lastErr.message });
    return {
      ok: false,
      canceled,
      message: canceled
        ? '已取消下载'
        : (isAuthReject(lastErr)
          ? (lastErr?.message || '下载源拒绝访问')
          : `重试 ${MAX_ATTEMPTS} 次仍失败：${lastErr?.message || '未知错误'}`)
    };
  } finally {
    tasks.delete(id);
  }
}

function cancel(id) {
  const task = tasks.get(id);
  if (!task) return false;
  task.controller.abort();
  return true;
}

function cancelAll() {
  for (const id of [...tasks.keys()]) cancel(id);
}

/** 官方失败（尤其 401）时依次换镜像，避免卡在同一个拒绝源上 */
function candidateBases(preferred) {
  return [...new Set([preferred, OFFICIAL, ...MIRRORS].filter(Boolean))];
}

module.exports = {
  resolveSource, searchRepos, listRepoFiles, pickFile, fileUrl, remoteSize,
  download, cancel, cancelAll, candidateBases, isAuthReject
};

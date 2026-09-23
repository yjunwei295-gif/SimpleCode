const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { isInside, SKIP } = require('./workspace');

// 命令前后扫描工作区时额外跳过的目录（避免 Library/bin 等大目录拖慢备份）
const SCAN_SKIP = new Set([
  ...SKIP,
  'bin', 'obj', 'Library', 'Temp', 'Logs', 'Build', 'Builds',
  '.vs', '.idea', 'target', '.gradle', 'DerivedDataCache', 'Packages'
]);
const SCAN_MAX_DEPTH = 12;
const SCAN_MAX_FILES = 8000;

const DEFAULT_MAX_SNAPSHOTS = 20;
const MIN_MAX = 1;
const MAX_MAX = 500;

function rootDir() {
  return path.join(app.getPath('userData'), 'snapshots');
}

function workspaceKey(workspace) {
  const n = path.resolve(String(workspace || '')).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha1').update(n).digest('hex').slice(0, 12);
}

function snapDir(workspace, id) {
  return path.join(rootDir(), workspaceKey(workspace), id);
}

function configPath(workspace) {
  if (!workspace) return null;
  const neu = path.join(workspace, '.simple', 'snapshot.json');
  const old = path.join(workspace, '.sinpo', 'snapshot.json');
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function clampMax(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_MAX_SNAPSHOTS;
  return Math.min(MAX_MAX, Math.max(MIN_MAX, v));
}

/** 读取当前项目的快照上限（默认 20） */
function getMax(workspace) {
  const p = configPath(workspace);
  if (!p || !fs.existsSync(p)) return DEFAULT_MAX_SNAPSHOTS;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return clampMax(data?.max ?? data?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  } catch {
    return DEFAULT_MAX_SNAPSHOTS;
  }
}

/** 设置当前项目的快照上限，并立刻按新上限淘汰旧快照 */
function setMax(workspace, max) {
  if (!workspace) throw new Error('请先打开项目');
  const limit = clampMax(max);
  const p = configPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ max: limit }, null, 2), 'utf8');
  prune(workspace, limit);
  return limit;
}

function relParts(relPath) {
  return String(relPath || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
}

function nestedUnder(root, relPath) {
  const parts = relParts(relPath);
  if (parts.some((p) => p === '..')) throw new Error('路径超出工作目录');
  return parts.length ? path.join(root, ...parts) : root;
}

function copyFileSafe(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function create(workspace, label) {
  // id 加随机短串，避免同一毫秒创建两条快照时撞车、复用旧目录导致覆盖
  const id = `snap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = snapDir(workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    workspace,
    label: label || '自动更改快照',
    changes: []
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  prune(workspace);
  return { id, dir, manifest };
}

function recordChange(workspace, snapshot, relPath, action, opts = {}) {
  if (!snapshot) return;
  const parts = relParts(relPath);
  const norm = parts.join('/');
  if (!norm) return;
  const abs = path.resolve(workspace, ...parts);
  if (!isInside(workspace, abs)) throw new Error('路径超出工作目录');
  const existed = opts.existedBefore != null
    ? !!opts.existedBefore
    : (fs.existsSync(abs) && fs.statSync(abs).isFile());
  const dest = nestedUnder(path.join(snapshot.dir, 'files'), norm);
  // 已有文件必须在第一次改之前备份；若记录已在但备份缺失则补上（此时可能已是新内容，尽量仍保留第一次备份）
  if (existed && !fs.existsSync(dest)) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) copyFileSafe(abs, dest);
    if (!fs.existsSync(dest)) throw new Error(`无法备份文件：${norm}`);
  }
  const already = snapshot.manifest.changes.find((c) => c.path === norm);
  if (already) {
    fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
    return;
  }
  snapshot.manifest.changes.push({
    path: norm,
    action,
    existed
  });
  fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
}

/** 扫描工作区普通文件的 mtime+size，供 run_command 前后 diff */
function scanFingerprints(workspace) {
  const map = new Map();
  if (!workspace) return map;
  const root = path.resolve(workspace);
  let truncated = false;

  function walk(dir, depth) {
    if (truncated || depth > SCAN_MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (map.size >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      if (SCAN_SKIP.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (!isInside(root, abs)) continue;
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        map.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 忽略单文件 stat 失败 */
      }
    }
  }

  walk(root, 0);
  map.truncated = truncated;
  return map;
}

function diffFingerprints(before, after) {
  const modified = [];
  const created = [];
  const deleted = [];
  for (const [rel, meta] of after || []) {
    if (rel === 'truncated') continue;
    const prev = before?.get(rel);
    if (!prev) {
      created.push(rel);
      continue;
    }
    if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) modified.push(rel);
  }
  for (const rel of before?.keys() || []) {
    if (rel === 'truncated') continue;
    if (!after?.has(rel)) deleted.push(rel);
  }
  return { modified, created, deleted };
}

/** run_command 执行前：把尚未备份的工作区文件拷进快照，避免脚本改完后备份到的是新内容 */
function preBackupWorkspace(workspace, snapshot) {
  if (!workspace || !snapshot?.dir) return { backed: 0, truncated: false };
  const root = path.resolve(workspace);
  const filesRoot = path.join(snapshot.dir, 'files');
  let backed = 0;
  let truncated = false;

  function walk(dir, depth) {
    if (truncated || depth > SCAN_MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (backed >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      if (SCAN_SKIP.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (!isInside(root, abs)) continue;
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const dest = nestedUnder(filesRoot, rel);
      if (fs.existsSync(dest)) continue;
      try {
        copyFileSafe(abs, dest);
        backed += 1;
      } catch {
        /* 忽略单文件备份失败 */
      }
    }
  }

  walk(root, 0);
  return { backed, truncated };
}

/** 对比 run_command 前后扫描结果，写入快照清单（可还原脚本改动） */
function recordCommandDiff(workspace, snapshot, before, after) {
  if (!snapshot) return [];
  const { modified, created, deleted } = diffFingerprints(before, after);
  const out = [];
  for (const rel of modified) {
    recordChange(workspace, snapshot, rel, 'write', { existedBefore: true });
    out.push({ path: rel, action: 'write', source: 'command' });
  }
  for (const rel of created) {
    recordChange(workspace, snapshot, rel, 'write', { existedBefore: false });
    out.push({ path: rel, action: 'write', source: 'command' });
  }
  for (const rel of deleted) {
    recordChange(workspace, snapshot, rel, 'delete', { existedBefore: true });
    out.push({ path: rel, action: 'delete', source: 'command' });
  }
  return out;
}

function list(workspace) {
  prune(workspace);
  return readAll(workspace);
}

function readAll(workspace) {
  const dir = path.join(rootDir(), workspaceKey(workspace));
  if (!dir || !fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir);
  const items = [];
  for (const id of ids) {
    const m = path.join(dir, id, 'manifest.json');
    if (!fs.existsSync(m)) continue;
    try {
      items.push(JSON.parse(fs.readFileSync(m, 'utf8')));
    } catch {
      /* 忽略损坏快照 */
    }
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

/** 每个项目只保留最近 N 份改前备份，超出则删掉最早的整包 */
function prune(workspace, maxOverride) {
  if (!workspace) return;
  const limit = maxOverride != null ? clampMax(maxOverride) : getMax(workspace);
  const items = readAll(workspace);
  for (const old of items.slice(limit)) {
    const dir = snapDir(workspace, old.id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

function restore(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [];
  for (const change of manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    if (!isInside(workspace, abs)) continue;
    const backup = nestedUnder(path.join(dir, 'files'), change.path);
    if (change.existed) {
      if (!fs.existsSync(backup)) continue;
      copyFileSafe(backup, abs);
      restored.push({ path: change.path, action: 'restore' });
    } else if (fs.existsSync(abs)) {
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      restored.push({ path: change.path, action: 'delete-created' });
    }
  }
  return { snapshotId, restored };
}

function captureAfter(workspace, snapshot) {
  if (!snapshot?.dir || !snapshot.manifest) return;
  for (const change of snapshot.manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    change.afterExisted = !!exists;
    if (exists) copyFileSafe(abs, nestedUnder(path.join(snapshot.dir, 'after'), change.path));
  }
  fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
}

function ensureAfter(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const snapshot = { id: snapshotId, dir, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  const afterRoot = path.join(dir, 'after');
  if (!fs.existsSync(afterRoot)) captureAfter(workspace, snapshot);
  return snapshot;
}

function undo(workspace, snapshotId) {
  ensureAfter(workspace, snapshotId);
  return restore(workspace, snapshotId);
}

function redo(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const redone = [];
  for (const change of manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    if (!isInside(workspace, abs)) continue;
    const after = nestedUnder(path.join(dir, 'after'), change.path);
    if (change.afterExisted && fs.existsSync(after)) {
      copyFileSafe(after, abs);
      redone.push({ path: change.path, action: 'redo' });
    } else if (change.afterExisted === false && fs.existsSync(abs)) {
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      redone.push({ path: change.path, action: 'redo-delete' });
    }
  }
  return { snapshotId, redone };
}

function splitKeep(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/);
}

function readTextIf(file) {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function listChangeHunks(beforeLines, afterLines) {
  if (beforeLines.length > 1200 || afterLines.length > 1200) {
    return [{
      index: 0,
      removed: beforeLines.slice(0, 40),
      added: afterLines.slice(0, 40),
      truncated: true
    }];
  }
  const dp = lcsTable(beforeLines, afterLines);
  const hunks = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur && (cur.removed.length || cur.added.length)) hunks.push(cur);
    cur = null;
  };
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!cur) cur = { removed: [], added: [] };
      cur.removed.push(beforeLines[i]);
      i++;
    } else {
      if (!cur) cur = { removed: [], added: [] };
      cur.added.push(afterLines[j]);
      j++;
    }
  }
  while (i < beforeLines.length) {
    if (!cur) cur = { removed: [], added: [] };
    cur.removed.push(beforeLines[i]);
    i++;
  }
  while (j < afterLines.length) {
    if (!cur) cur = { removed: [], added: [] };
    cur.added.push(afterLines[j]);
    j++;
  }
  flush();
  return hunks.map((h, index) => ({ index, removed: h.removed, added: h.added }));
}

function mergeReject(beforeLines, afterLines, rejectIndex) {
  const dp = lcsTable(beforeLines, afterLines);
  const out = [];
  let i = 0;
  let j = 0;
  let hunk = -1;
  let inChange = false;
  const touch = () => {
    if (!inChange) {
      inChange = true;
      hunk++;
    }
  };
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      inChange = false;
      out.push(afterLines[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      touch();
      if (hunk === rejectIndex) out.push(beforeLines[i]);
      i++;
    } else {
      touch();
      if (hunk !== rejectIndex) out.push(afterLines[j]);
      j++;
    }
  }
  while (i < beforeLines.length) {
    touch();
    if (hunk === rejectIndex) out.push(beforeLines[i]);
    i++;
  }
  while (j < afterLines.length) {
    touch();
    if (hunk !== rejectIndex) out.push(afterLines[j]);
    j++;
  }
  return out;
}

function fileEnds(workspace, snapshotId, relPath) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const change = (manifest.changes || []).find((c) => c.path === String(relPath || '').replace(/\\/g, '/'));
  if (!change) throw new Error('这份快照里没有该文件');
  const parts = relParts(change.path);
  const abs = path.resolve(workspace, ...parts);
  if (!isInside(workspace, abs)) throw new Error('路径超出工作目录');
  const backup = change.existed ? readTextIf(nestedUnder(path.join(dir, 'files'), change.path)) : '';
  const current = fs.existsSync(abs) && fs.statSync(abs).isFile() ? readTextIf(abs) : '';
  return { change, abs, beforeLines: splitKeep(backup), afterLines: splitKeep(current) };
}

function listFileHunks(workspace, snapshotId, relPath) {
  const { change, beforeLines, afterLines } = fileEnds(workspace, snapshotId, relPath);
  const hunks = listChangeHunks(beforeLines, afterLines).map((h) => ({
    index: h.index,
    removed: h.removed.slice(0, 40),
    added: h.added.slice(0, 40),
    removedMore: Math.max(0, h.removed.length - 40),
    addedMore: Math.max(0, h.added.length - 40),
    truncated: !!h.truncated
  }));
  return { path: change.path, hunks };
}

function rejectFileHunk(workspace, snapshotId, relPath, hunkIndex) {
  const { change, abs, beforeLines, afterLines } = fileEnds(workspace, snapshotId, relPath);
  if (beforeLines.length > 1200 || afterLines.length > 1200) {
    throw new Error('文件太大，请用整份还原');
  }
  const index = Number(hunkIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('代码块编号无效');
  const merged = mergeReject(beforeLines, afterLines, index);
  const text = merged.join('\n');
  if (!change.existed && !text) {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = text && !text.endsWith('\n') ? `${text}\n` : text;
    fs.writeFileSync(abs, body, 'utf8');
  }
  return listFileHunks(workspace, snapshotId, change.path);
}

module.exports = {
  create, recordChange, captureAfter, list, restore, undo, redo,
  scanFingerprints, diffFingerprints, preBackupWorkspace, recordCommandDiff,
  listFileHunks, rejectFileHunk,
  getMax, setMax, DEFAULT_MAX_SNAPSHOTS, MIN_MAX, MAX_MAX
};

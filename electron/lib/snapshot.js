const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { isInside } = require('./workspace');

const MAX_SNAPSHOTS = 20;

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

function recordChange(workspace, snapshot, relPath, action) {
  if (!snapshot) return;
  const parts = relParts(relPath);
  const norm = parts.join('/');
  if (!norm) return;
  const abs = path.resolve(workspace, ...parts);
  if (!isInside(workspace, abs)) throw new Error('路径超出工作目录');
  const existed = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const dest = nestedUnder(path.join(snapshot.dir, 'files'), norm);
  // 已有文件必须在第一次改之前备份；若记录已在但备份缺失则补上（此时可能已是新内容，尽量仍保留第一次备份）
  if (existed && !fs.existsSync(dest)) {
    copyFileSafe(abs, dest);
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

/** 每个项目只保留最近 20 份改前备份，超出则删掉最早的整包 */
function prune(workspace) {
  if (!workspace) return;
  const items = readAll(workspace);
  for (const old of items.slice(MAX_SNAPSHOTS)) {
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

module.exports = { create, recordChange, captureAfter, list, restore, undo, redo };

const fs = require('fs');
const path = require('path');

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', '.sinpo-snapshots', '.simple', '.sinpo',
  '.next', 'coverage', '__pycache__', '.venv', 'venv'
]);

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeJoin(root, relPath) {
  const abs = path.resolve(root, relPath || '');
  if (!isInside(root, abs)) throw new Error('路径超出工作目录');
  return abs;
}

function extraRoots(appRoot, workspace) {
  const roots = [];
  if (appRoot) {
    roots.push(path.join(appRoot, 'skills'));
    roots.push(path.join(appRoot, 'rules'));
  }
  if (workspace) {
    roots.push(path.join(workspace, '.simple', 'skills'));
    roots.push(path.join(workspace, '.simple', 'rules'));
    roots.push(path.join(workspace, '.sinpo', 'skills'));
    roots.push(path.join(workspace, '.sinpo', 'rules'));
  }
  return roots.map((r) => path.resolve(r));
}

function resolveAllowed(workspace, extra, relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) throw new Error('路径为空');
  const roots = [];
  if (workspace) roots.push(path.resolve(workspace));
  for (const r of extra || []) roots.push(path.resolve(r));
  const tries = [];
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) tries.push(path.resolve(raw));
  for (const r of roots) tries.push(path.resolve(r, raw));
  const allowed = (abs) => roots.some((r) => isInside(r, abs));
  for (const abs of tries) {
    if (allowed(abs) && fs.existsSync(abs)) return abs;
  }
  for (const abs of tries) {
    if (allowed(abs)) return abs;
  }
  throw new Error('路径超出允许范围（工作目录或技能/规则目录）');
}

function listTree(root, { max = 400, query = '' } = {}) {
  const out = [];
  const q = (query || '').toLowerCase();

  function walk(dir, depth) {
    if (out.length >= max || depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
      } else if (!q || rel.toLowerCase().includes(q) || ent.name.toLowerCase().includes(q)) {
        out.push({ path: rel, name: ent.name });
      }
    }
  }

  walk(root, 0);
  return out;
}

function listChildren(root, rel = '') {
  const dir = rel ? path.join(root, rel) : root;
  if (!isInside(root, dir)) throw new Error('路径超出工作目录');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hide = new Set(['.git', '.sinpo-snapshots', '.simple', '.sinpo']);
  const items = [];
  for (const ent of entries) {
    if (hide.has(ent.name)) continue;
    const childRel = rel ? `${String(rel).replace(/\\/g, '/')}/${ent.name}` : ent.name;
    items.push({ name: ent.name, path: childRel, dir: ent.isDirectory() });
  }
  items.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return items;
}

function readTextLimited(abs, maxBytes = 512 * 1024) {
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8') + '\n\n[文件过大，已截断]';
  }
  return fs.readFileSync(abs, 'utf8');
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 只读预览：文本 / 图片 / 二进制
 * @param {string} root 工作目录
 * @param {string} rel 相对路径
 * @returns {{ kind: string, path: string, name: string, content?: string, truncated?: boolean }}
 */
function readForPreview(root, rel, maxBytes = 512 * 1024) {
  const abs = safeJoin(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const name = path.basename(abs);
  const filePath = String(rel || '').replace(/\\/g, '/');
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  const stat = fs.statSync(abs);
  if (mime) {
    if (stat.size > 8 * 1024 * 1024) throw new Error('图片过大');
    const buf = fs.readFileSync(abs);
    return { kind: 'image', path: filePath, name, content: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const truncated = stat.size > maxBytes;
  let buf;
  if (truncated) {
    buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
  } else {
    buf = fs.readFileSync(abs);
  }
  if (isProbablyBinary(buf)) return { kind: 'binary', path: filePath, name };
  let content = buf.toString('utf8');
  if (truncated) content += '\n\n[文件过大，已截断]';
  return { kind: 'text', path: filePath, name, content, truncated };
}

module.exports = {
  isInside, safeJoin, resolveAllowed, extraRoots, listTree, listChildren,
  readTextLimited, readForPreview, SKIP
};

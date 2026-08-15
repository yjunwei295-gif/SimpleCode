const fs = require('fs');
const path = require('path');

function readSkillDir(dir, scope) {
  if (!dir || !fs.existsSync(dir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    const md = ent.isDirectory()
      ? path.join(dir, ent.name, 'SKILL.md')
      : (ent.name.toLowerCase().endsWith('.md') ? path.join(dir, ent.name) : null);
    if (!md || !fs.existsSync(md)) continue;
    const body = fs.readFileSync(md, 'utf8');
    const name = ent.isDirectory() ? ent.name : path.basename(ent.name, '.md');
    const first = body.split(/\r?\n/).find((l) => l.trim()) || name;
    const desc = first.replace(/^#\s*/, '').trim();
    items.push({ id: name, name, desc, body, file: md, scope });
  }
  return items;
}

function appSkillsDir(appRoot) {
  return path.join(appRoot, 'skills');
}

const META_DIR = '.simple';
const LEGACY_META = '.sinpo';

function pickMetaPath(workspace, sub) {
  if (!workspace) return null;
  const neu = path.join(workspace, META_DIR, sub);
  const old = path.join(workspace, LEGACY_META, sub);
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function workspaceSkillsDir(workspace) {
  return pickMetaPath(workspace, 'skills');
}

function skillKey(s) {
  return `${s.scope || 'app'}:${s.id}`;
}

function applyOrder(skills, order) {
  const rank = new Map((order || []).map((o, i) => [`${o.scope || 'app'}:${o.id}`, i]));
  return [...skills].sort((a, b) => {
    const ra = rank.has(skillKey(a)) ? rank.get(skillKey(a)) : 10000 + skills.indexOf(a);
    const rb = rank.has(skillKey(b)) ? rank.get(skillKey(b)) : 10000 + skills.indexOf(b);
    return ra - rb;
  });
}

function listDetailed(appDir, workspace, order) {
  const all = applyOrder([
    ...readSkillDir(appDir, 'app'),
    ...readSkillDir(workspaceSkillsDir(workspace), 'workspace')
  ], order);
  const seen = new Set();
  return all.map((s, i) => {
    const active = !seen.has(s.id);
    if (active) seen.add(s.id);
    return { ...s, priority: i + 1, active };
  });
}

function loadAll(appDir, workspace, order) {
  return listDetailed(appDir, workspace, order).filter((s) => s.active);
}

function sanitizeId(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('请填写技能名称');
  if (/[\\/:*?"<>|]/.test(s) || s.includes('..')) throw new Error('技能名称不能包含 \\ / : * ? " < > |');
  return s;
}

function resolveDir(appRoot, workspace, scope) {
  if (scope === 'workspace') {
    if (!workspace) throw new Error('请先打开项目，才能保存项目技能');
    return workspaceSkillsDir(workspace);
  }
  return appSkillsDir(appRoot);
}

function removeSkillFolder(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const md = path.join(dir, 'SKILL.md');
  if (fs.existsSync(md)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (dir.toLowerCase().endsWith('.md') && fs.existsSync(dir)) fs.unlinkSync(dir);
}

function saveSkill(appRoot, workspace, { id, body, scope, oldId }) {
  const name = sanitizeId(id);
  const dirRoot = resolveDir(appRoot, workspace, scope || 'app');
  fs.mkdirSync(dirRoot, { recursive: true });
  const folder = path.join(dirRoot, name);
  fs.mkdirSync(folder, { recursive: true });
  const text = String(body ?? '').trim() ? String(body) : `# ${name}\n\n什么时候用：\n\n要怎么做：\n`;
  fs.writeFileSync(path.join(folder, 'SKILL.md'), text, 'utf8');
  if (oldId && oldId !== name) {
    removeSkillFolder(path.join(dirRoot, oldId));
  }
}

function deleteSkill(appRoot, workspace, { id, scope }) {
  const name = sanitizeId(id);
  const dirRoot = resolveDir(appRoot, workspace, scope || 'app');
  const folder = path.join(dirRoot, name);
  const flat = path.join(dirRoot, `${name}.md`);
  if (fs.existsSync(folder)) removeSkillFolder(folder);
  else if (fs.existsSync(flat)) fs.unlinkSync(flat);
  else throw new Error('技能不存在');
}

function readRuleDir(dir, scope) {
  if (!dir || !fs.existsSync(dir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    if (ent.name.toLowerCase() === 'persona.md') continue; // 人设单独管理，不算普通规则
    const file = path.join(dir, ent.name);
    const body = fs.readFileSync(file, 'utf8');
    const name = path.basename(ent.name, '.md');
    const first = body.split(/\r?\n/).find((l) => l.trim()) || name;
    items.push({ id: name, name, desc: first.replace(/^#\s*/, '').trim(), body, file, scope });
  }
  return items;
}

function loadRules(appRulesDir, workspace) {
  const neu = workspace ? path.join(workspace, META_DIR, 'rules') : null;
  const old = workspace ? path.join(workspace, LEGACY_META, 'rules') : null;
  const all = [
    ...readRuleDir(appRulesDir, 'app'),
    ...readRuleDir(neu, 'workspace'),
    ...readRuleDir(old, 'workspace')
  ];
  const seen = new Set();
  return all.filter((r) => {
    const k = `${r.scope}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function resolveRuleDir(appRoot, workspace, scope) {
  if (scope === 'workspace') {
    if (!workspace) throw new Error('请先打开项目，才能保存项目规则');
    return path.join(workspace, META_DIR, 'rules');
  }
  return path.join(appRoot, 'rules');
}

function sanitizeRuleId(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('请填写规则名称');
  if (/[\\/:*?"<>|]/.test(s) || s.includes('..')) throw new Error('规则名称不能包含 \\ / : * ? " < > |');
  return s;
}

function saveRule(appRoot, workspace, { id, body, scope, oldId }) {
  const name = sanitizeRuleId(id);
  const dir = resolveRuleDir(appRoot, workspace, scope || 'app');
  fs.mkdirSync(dir, { recursive: true });
  const text = String(body ?? '').trim() ? String(body) : `# ${name}\n\n（规则内容）\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text, 'utf8');
  if (oldId && oldId !== name) {
    const old = path.join(dir, `${oldId}.md`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
}

function deleteRule(appRoot, workspace, { id, scope }) {
  const name = sanitizeRuleId(id);
  const dir = resolveRuleDir(appRoot, workspace, scope || 'app');
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  else throw new Error('规则不存在');
}

function personaFile(appRoot) {
  return path.join(appRoot, 'rules', 'persona.md');
}

function loadPersona(appRoot) {
  const file = personaFile(appRoot);
  if (!fs.existsSync(file)) return { body: '' };
  return { body: fs.readFileSync(file, 'utf8') };
}

function savePersona(appRoot, body) {
  const file = personaFile(appRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(body ?? ''), 'utf8');
}

module.exports = {
  loadAll, listDetailed, saveSkill, deleteSkill,
  loadRules, saveRule, deleteRule, loadPersona, savePersona
};

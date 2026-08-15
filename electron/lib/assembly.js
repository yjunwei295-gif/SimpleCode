const path = require('path');

const ROLES = [
  { id: 'vision', name: '看图', hint: '主模型看不到图时，先用这个模型识别画面' },
  { id: 'summary', name: '总结', hint: '长文、摘要、概括时先压缩再交给主模型' },
  { id: 'code', name: '代码', hint: '写代码、改 bug 时先出一版草案再交给主模型' },
  { id: 'planning', name: '规划', hint: '复杂任务先拆步骤再交给主模型执行' }
];

function assemblyKey(s) {
  const m = (s.models || []).find((x) => x.id === s.currentModelId);
  if (!m || m.type === 'local' || m.id === 'local-gguf') {
    const name = path.basename(String(m?.modelPath || m?.model || ''));
    return name ? `local:${name}` : 'local';
  }
  return `api:${m.id}`;
}

function slotsOf(s, key) {
  const pack = (s.assemblies || {})[key || assemblyKey(s)];
  return Array.isArray(pack?.slots) ? pack.slots : [];
}

function slotByRole(s, role) {
  return slotsOf(s).find((x) => x.role === role && (x.model || x.apiId)) || null;
}

function looksLikeModelNotProjector(file, modelName) {
  const leaf = path.basename(String(file || ''));
  if (!leaf) return false;
  if (/mmproj/i.test(leaf) || /\.mmproj$/i.test(leaf)) return false;
  const modelLeaf = path.basename(String(modelName || ''));
  return leaf.toLowerCase() === modelLeaf.toLowerCase() || (/\.gguf$/i.test(leaf) && !/mmproj/i.test(leaf));
}

function scrubBadMmproj(s) {
  const wipe = (model, mm) => (looksLikeModelNotProjector(mm, model) ? '' : mm);
  s.visionAgentMmproj = wipe(s.visionAgentModel, s.visionAgentMmproj);
  for (const pack of Object.values(s.assemblies || {})) {
    for (const slot of pack.slots || []) {
      if (slot.role === 'vision') slot.mmproj = wipe(slot.model, slot.mmproj);
    }
  }
}

/** 把旧的三个视觉字段迁进当前主模型的组合，只迁一次 */
function migrateAssemblies(s) {
  if (!s.assemblies || typeof s.assemblies !== 'object') s.assemblies = {};
  scrubBadMmproj(s);
  const hasVision = Object.values(s.assemblies).some((a) =>
    (a?.slots || []).some((x) => x.role === 'vision' && (x.model || x.apiId))
  );
  if (hasVision || !s.visionAgentModel) return s;
  const key = assemblyKey(s);
  if (!s.assemblies[key]) s.assemblies[key] = { slots: [] };
  if (!s.assemblies[key].slots.some((x) => x.role === 'vision')) {
    s.assemblies[key].slots.push({
      id: 'slot-vision-migrated',
      role: 'vision',
      type: 'local',
      model: s.visionAgentModel,
      mmproj: s.visionAgentMmproj || '',
      endpoint: s.visionAgentEndpoint || ''
    });
  }
  return s;
}

function visionFrom(s) {
  const slot = slotByRole(s, 'vision');
  if (slot) {
    return {
      model: slot.model || '',
      mmproj: slot.mmproj || '',
      endpoint: slot.endpoint || ''
    };
  }
  return {
    model: s.visionAgentModel || '',
    mmproj: s.visionAgentMmproj || '',
    endpoint: s.visionAgentEndpoint || ''
  };
}

function syncVisionFields(s, slots) {
  const vision = (slots || []).find((x) => x.role === 'vision');
  if (!vision) return;
  s.visionAgentModel = vision.model || '';
  s.visionAgentMmproj = vision.mmproj || '';
  s.visionAgentEndpoint = vision.endpoint || '';
}

function slotToModelCfg(slot, s) {
  if (!slot) return null;
  if (slot.apiId) {
    const m = (s.models || []).find((x) => x.id === slot.apiId);
    if (m) return m;
  }
  if (slot.type === 'api' && slot.baseUrl) {
    return {
      type: 'api',
      name: slot.name || slot.model,
      baseUrl: slot.baseUrl,
      apiKey: slot.apiKey || '',
      model: slot.model
    };
  }
  return {
    type: 'local',
    name: slot.model || '本地辅助模型',
    model: slot.model || '',
    modelPath: slot.modelPath || ''
  };
}

function detectRoles(userText, { hasImages, contextChars }) {
  const t = String(userText || '');
  const roles = [];
  if (hasImages) roles.push('vision');
  if (/总结|摘要|概括|精简|summar/i.test(t) || (contextChars || 0) > 8000) roles.push('summary');
  if (/写代码|改代码|重构|实现|修 bug|修bug|函数|组件|补全/i.test(t)) roles.push('code');
  if (/规划|计划|拆解|分步|方案|怎么做/i.test(t)) roles.push('planning');
  return roles;
}

function helperPrompt(role, lang) {
  const replyLang = require('./reply-lang');
  const langLine = replyLang.helperLangLine(lang || replyLang.fromLocale('zh'));
  if (role === 'summary') {
    return `You are a summarization helper. Compress the user's material into key points. Keep paths, API names, and numbers. Do not call tools. Do not invent facts. ${langLine}`;
  }
  if (role === 'code') {
    return `You are a coding helper. Give a concrete patch or draft and which files to touch. Do not call tools. ${langLine}`;
  }
  if (role === 'planning') {
    return `You are a planning helper. Split the task into steps with order and risks. Do not call tools. ${langLine}`;
  }
  return `Answer briefly. Do not call tools. ${langLine}`;
}

module.exports = {
  ROLES, assemblyKey, slotsOf, slotByRole, migrateAssemblies,
  visionFrom, syncVisionFields, slotToModelCfg, detectRoles, helperPrompt
};

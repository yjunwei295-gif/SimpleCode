const path = require('path');

const ROLES = [
  { id: 'vision', name: '看图', hint: '主模型看不到图时，先用这个模型识别画面' },
  { id: 'summary', name: '总结', hint: '长文、摘要、概括时先压缩再交给主模型' },
  { id: 'code', name: '代码', hint: '写代码、改 bug 时先出一版草案再交给主模型' },
  { id: 'planning', name: '规划', hint: '复杂任务先拆步骤再交给主模型执行' },
  { id: 'imageGen', name: '生图', hint: '画图、出插画时用挂上的接口直接出图' },
  { id: 'videoGen', name: '生视频', hint: '做短片时用挂上的接口直接出视频' },
  { id: 'model3d', name: '生3D', hint: '做三维模型时用挂上的接口直接出 3D 文件' },
  { id: 'docGen', name: '生文档', hint: '写说明、手册时先成文再保存到工作目录' }
];

const GEN_ROLE_IDS = ['imageGen', 'videoGen', 'model3d', 'docGen'];
const TEXT_HELPER_IDS = ['summary', 'code', 'planning'];

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
  if (/生成视频|生视频|做个视频|做一段视频|text to video|generate (a |an )?video|视频生成/i.test(t)) {
    roles.push('videoGen');
  }
  if (/生成\s*3D|3D\s*模型|三维模型|生3D|generate (a |an )?3d|text to 3d/i.test(t)) {
    roles.push('model3d');
  }
  if (/生成文档|写一份文档|写文档|生文档|生成一份(说明|文档|手册)|write (a |an )?document/i.test(t)) {
    roles.push('docGen');
  }
  if (
    /生图|画一张|画个|帮我画|生成(一张|几张)?(图片|插画|海报)|text to image|generate (an |a )?image/i.test(t)
    && !roles.includes('videoGen')
    && !roles.includes('model3d')
  ) {
    roles.push('imageGen');
  }
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
  if (role === 'docGen') {
    return `You write a complete markdown document from the user's request. Output markdown only, no chatter. Start with a title. Do not call tools. ${langLine}`;
  }
  return `Answer briefly. Do not call tools. ${langLine}`;
}

module.exports = {
  ROLES, GEN_ROLE_IDS, TEXT_HELPER_IDS, assemblyKey, slotsOf, slotByRole, migrateAssemblies,
  visionFrom, syncVisionFields, slotToModelCfg, detectRoles, helperPrompt
};

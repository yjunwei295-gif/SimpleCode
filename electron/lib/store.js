const { app, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const LOCAL_SLOT = {
  id: 'local-gguf',
  name: '本地模型',
  type: 'local',
  model: '',
  modelPath: '',
  vision: false
};

const DEFAULTS = {
  theme: 'system',
  locale: 'zh',
  autoSave: true,
  currentModelId: 'local-gguf',
  visionAgentModel: '',
  visionAgentMmproj: '',
  visionAgentEndpoint: '',
  assemblies: {},
  modelsDir: '',
  models: [
    { ...LOCAL_SLOT },
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1',
      type: 'api',
      vision: true
    }
  ],
  recents: [],
  sshProfiles: [],
  skillOrder: [],
  searchSites: []
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function bundledModelsDir() {
  return path.join(__dirname, '..', '..', 'models');
}

function defaultModelsDir() {
  return bundledModelsDir();
}

function isOllamaEntry(m) {
  if (!m) return false;
  if (m.id === 'ollama-local') return true;
  const url = String(m.baseUrl || '');
  return /11434/.test(url);
}

function migrateModels(models) {
  const kept = (models || []).filter((m) => !isOllamaEntry(m));
  if (!kept.some((m) => m.id === 'local-gguf' || m.type === 'local')) {
    kept.unshift({ ...LOCAL_SLOT });
  }
  const local = kept.find((m) => m.id === 'local-gguf') || kept.find((m) => m.type === 'local');
  if (local) {
    local.id = 'local-gguf';
    local.name = local.name || '本地模型';
    local.type = 'local';
    delete local.baseUrl;
    delete local.apiKey;
    if (!local.model) {
      const prefer = path.join(bundledModelsDir(), 'qwen2.5-7b.gguf');
      if (fs.existsSync(prefer)) {
        local.model = 'qwen2.5-7b.gguf';
        local.modelPath = prefer;
      }
    }
  }
  return kept;
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const data = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...data };
    merged.models = migrateModels(data.models && data.models.length ? data.models : DEFAULTS.models);
    const bundled = bundledModelsDir();
    const legacy = path.join(app.getPath('userData'), 'models');
    if (!merged.modelsDir || merged.modelsDir === legacy) merged.modelsDir = bundled;
    if (!merged.models.some((m) => m.id === merged.currentModelId)) {
      merged.currentModelId = merged.models[0]?.id || 'local-gguf';
    }
    merged.locale = merged.locale === 'en' ? 'en' : 'zh';
    if (!Array.isArray(merged.searchSites)) merged.searchSites = [];
    const before = JSON.stringify(merged.assemblies || {});
    const out = require('./assembly').migrateAssemblies(merged);
    if (JSON.stringify(out.assemblies || {}) !== before) {
      try { save(out); } catch { /* 迁移写入失败不影响本次运行 */ }
    }
    return out;
  } catch {
    const fresh = structuredClone(DEFAULTS);
    fresh.modelsDir = defaultModelsDir();
    return fresh;
  }
}

function save(data) {
  const dir = path.dirname(filePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
}

function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

module.exports = { load, save, resolveTheme, DEFAULTS, defaultModelsDir, migrateModels };

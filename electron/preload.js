const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('app:state'),
  setTheme: (theme) => ipcRenderer.invoke('app:theme', theme),
  setLocale: (locale) => ipcRenderer.invoke('app:locale', locale),
  setAutoSave: (v) => ipcRenderer.invoke('app:autoSave', v),
  saveSearchSites: (sites) => ipcRenderer.invoke('app:searchSites', sites),
  newWindow: () => ipcRenderer.invoke('window:new'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  openProject: () => ipcRenderer.invoke('workspace:open'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),
  listFiles: (query) => ipcRenderer.invoke('workspace:files', query),
  listChildren: (rel) => ipcRenderer.invoke('workspace:children', rel),
  readWorkspaceFile: (rel) => ipcRenderer.invoke('workspace:read', rel),
  showInFolder: (rel) => ipcRenderer.invoke('shell:showInFolder', rel),
  filePreview: (abs) => ipcRenderer.invoke('file:preview', abs),
  cloneRepo: (payload) => ipcRenderer.invoke('git:clone', payload),
  sshConnect: (profile) => ipcRenderer.invoke('ssh:connect', profile),

  saveModels: (models, currentModelId) => ipcRenderer.invoke('models:save', { models, currentModelId }),
  saveVisionAgent: (payload) => ipcRenderer.invoke('models:saveVision', payload),
  saveAssembly: (payload) => ipcRenderer.invoke('models:saveAssembly', payload),
  startVisionAgent: () => ipcRenderer.invoke('models:visionStart'),
  findMmproj: (modelName) => ipcRenderer.invoke('models:findMmproj', modelName),
  visionAgentStatus: () => ipcRenderer.invoke('models:visionStatus'),
  testModel: (model) => ipcRenderer.invoke('models:test', model),
  listLocalModels: () => ipcRenderer.invoke('models:listLocal'),
  pickModelsDir: () => ipcRenderer.invoke('models:pickDir'),
  openModelsDir: () => ipcRenderer.invoke('models:openDir'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: (payload) => ipcRenderer.invoke('skills:save', payload),
  deleteSkill: (payload) => ipcRenderer.invoke('skills:delete', payload),
  reorderSkills: (order) => ipcRenderer.invoke('skills:reorder', order),
  listRules: () => ipcRenderer.invoke('rules:list'),
  saveRule: (payload) => ipcRenderer.invoke('rules:save', payload),
  deleteRule: (payload) => ipcRenderer.invoke('rules:delete', payload),
  loadPersona: () => ipcRenderer.invoke('persona:load'),
  savePersona: (body) => ipcRenderer.invoke('persona:save', body),
  listSnapshots: () => ipcRenderer.invoke('snapshot:list'),
  restoreSnapshot: (id) => ipcRenderer.invoke('snapshot:restore', id),
  undoSnapshot: (id) => ipcRenderer.invoke('snapshot:undo', id),
  redoSnapshot: (id) => ipcRenderer.invoke('snapshot:redo', id),

  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  clipboardPasteSync: () => ipcRenderer.sendSync('clipboard:paste-sync'),
  savePasteFile: (payload) => ipcRenderer.invoke('paste:save', payload),
  loadSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (session) => ipcRenderer.invoke('sessions:save', session),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatAbort: () => ipcRenderer.invoke('chat:abort'),
  onChatEvent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
  },
  onWorkspaceChanged: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('workspace:changed', fn);
    return () => ipcRenderer.removeListener('workspace:changed', fn);
  },
  onUiRefresh: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('ui:refresh', fn);
    return () => ipcRenderer.removeListener('ui:refresh', fn);
  },

  reportError: (message, detail) => ipcRenderer.send('log:client', { message, detail }),

  detectHardware: () => ipcRenderer.invoke('hw:detect'),
  modelAdvice: (purpose) => ipcRenderer.invoke('hw:advice', purpose),
  downloadSource: (opts) => ipcRenderer.invoke('download:source', opts),
  searchRepos: (query) => ipcRenderer.invoke('download:search', query),
  listRepoFiles: (repo) => ipcRenderer.invoke('download:repoFiles', repo),
  resolveDownload: (payload) => ipcRenderer.invoke('download:resolve', payload),
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', id),
  onDownloadProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', fn);
    return () => ipcRenderer.removeListener('download:progress', fn);
  },
  onVisionStatus: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('vision:status', fn);
    return () => ipcRenderer.removeListener('vision:status', fn);
  }
};

contextBridge.exposeInMainWorld('simple', api);
contextBridge.exposeInMainWorld('sinpo', api);

const fs = require('fs');
const path = require('path');
const { safeJoin, resolveAllowed, extraRoots, listTree, readTextLimited, isInside, SKIP } = require('./workspace');
const snapshot = require('./snapshot');
const skillsLib = require('./skills');
const { parseAttachment, isDocumentExt, isImageExt } = require('./media');
const localLlm = require('./local-llm');
const store = require('./store');
const diag = require('./diag');
const assembly = require('./assembly');
const mmproj = require('./mmproj');
const visionEngine = require('./vision-engine');
const replyLang = require('./reply-lang');
const webSearch = require('./web-search');
const generate = require('./generate');

const MAX_ROUNDS = 32;

function toolsSpec() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出工作目录以及技能/规则目录下的文件',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '可选，按路径或文件名过滤' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取工作目录或技能/规则目录内的文本，也可解析 Word/Excel/PPT/PDF 文档文字',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对工作目录的路径' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入或覆盖工作目录内的文件（UTF-8）。会先自动快照。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: '删除工作目录内的文件。会先自动快照。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: '在工作目录中搜索文本',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            glob: { type: 'string', description: '可选扩展名，如 .js' }
          },
          required: ['query']
        }
      }
    }
  ];
}

// 搜索时跳过的二进制/大体积格式，避免把模型权重、压缩包整个读进内存
const SEARCH_SKIP_EXT = new Set([
  '.gguf', '.bin', '.safetensors', '.pt', '.onnx', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.iso', '.pdf', '.mp4', '.mov', '.avi', '.mkv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.woff', '.woff2', '.ttf'
]);
// 单个文件超过这个大小就不参与文本搜索
const SEARCH_MAX_BYTES = 1024 * 1024;

function searchText(root, query, globExt) {
  const hits = [];
  const q = query.toLowerCase();
  function walk(dir, depth) {
    if (hits.length >= 40 || depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= 40) return;
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, depth + 1);
      else {
        if (globExt && !ent.name.toLowerCase().endsWith(globExt.toLowerCase())) continue;
        if (SEARCH_SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        try {
          if (fs.statSync(abs).size > SEARCH_MAX_BYTES) continue;
          const text = fs.readFileSync(abs, 'utf8');
          if (text.includes('\u0000')) continue;
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (hits.length >= 40) return;
            if (line.toLowerCase().includes(q)) {
              hits.push(`${path.relative(root, abs).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
    }
  }
  walk(root, 0);
  return hits.join('\n') || '无匹配';
}

async function execTool(workspace, snap, name, args, onEvent, extra, signal, lang) {
  extra = extra || [];
  if (name === 'list_dir') {
    const q = args.query || '';
    const chunks = [];
    if (workspace) {
      const files = listTree(workspace, { query: q, max: 300 });
      chunks.push(files.map((f) => f.path).join('\n') || '(工作目录为空)');
    }
    for (const root of extra) {
      if (!fs.existsSync(root)) continue;
      const files = listTree(root, { query: q, max: 80 });
      const lines = files.map((f) => path.join(root, f.path).replace(/\\/g, '/'));
      chunks.push(`[技能/规则] ${root.replace(/\\/g, '/')}\n${lines.join('\n') || '(空)'}`);
    }
    return chunks.join('\n\n') || '(空目录)';
  }
  if (name === 'read_file') {
    const abs = resolveAllowed(workspace, extra, args.path);
    onEvent({ type: 'tool', name, status: 'running', detail: abs });
    const ext = path.extname(abs).toLowerCase();
    if (isImageExt(ext)) {
      const text = await describeImageFile(abs, { signal, onEvent, lang });
      onEvent({ type: 'tool', name, status: 'done', detail: abs });
      return text;
    }
    if (isDocumentExt(ext)) {
      const parsed = await parseAttachment(abs, { signal });
      const note = parsed.images?.length
        ? `\n\n[文档内含 ${parsed.images.length} 张图。若已挂看图模型，请让用户把图作为附件发送，或把图片文件单独 read_file。]`
        : '';
      return `${parsed.text || ''}${note}`;
    }
    return readTextLimited(abs);
  }
  if (name === 'write_file') {
    const rel = String(args.path).replace(/\\/g, '/');
    const abs = resolveAllowed(workspace, extra, rel);
    const content = String(args.content ?? '');
    const inWs = workspace && isInside(workspace, abs);
    diag.log('tool', '开始写文件', { path: abs, bytes: Buffer.byteLength(content, 'utf8'), inWs: !!inWs });
    try {
      if (inWs) {
        const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
        if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
        snapshot.recordChange(workspace, snap.current, wsRel, 'write');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    } catch (err) {
      diag.log('tool', '写文件失败', { path: abs, message: err && err.message, stack: err && err.stack });
      throw err;
    }
    diag.log('tool', '写文件完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    return `已写入 ${abs}`;
  }
  if (name === 'delete_file') {
    const rel = String(args.path).replace(/\\/g, '/');
    const abs = resolveAllowed(workspace, extra, rel);
    const inWs = workspace && isInside(workspace, abs);
    diag.log('tool', '开始删文件', { path: abs, inWs: !!inWs });
    try {
      if (inWs) {
        const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
        if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
        snapshot.recordChange(workspace, snap.current, wsRel, 'delete');
      }
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (err) {
      diag.log('tool', '删文件失败', { path: abs, message: err && err.message, stack: err && err.stack });
      throw err;
    }
    diag.log('tool', '删文件完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    return `已删除 ${abs}`;
  }
  if (name === 'search_text') {
    return searchText(workspace, args.query || '', args.glob || '');
  }
  return `未知工具：${name}`;
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeGeneratedFile(workspace, extra, snap, rel, data, encoding) {
  if (!workspace) throw new Error('请先打开项目，生成的文件才能保存到工作目录。');
  const abs = resolveAllowed(workspace, extra, rel);
  const inWs = isInside(workspace, abs);
  if (inWs) {
    const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
    if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
    snapshot.recordChange(workspace, snap.current, wsRel, 'write');
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (encoding === 'utf8') fs.writeFileSync(abs, data, 'utf8');
  else fs.writeFileSync(abs, data);
  return path.relative(workspace, abs).replace(/\\/g, '/');
}

/**
 * 生图/生视频/生3D/生文档：按组合槽位出文件，再把路径注入主模型
 */
async function runGenerateSlots({ vs, userText, workspace, extra, extraTexts, onEvent, signal, snap, lang }) {
  const wanted = assembly.detectRoles(userText, { hasImages: false, contextChars: 0 })
    .filter((r) => assembly.GEN_ROLE_IDS.includes(r));
  for (const role of wanted) {
    const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
    const slot = assembly.slotByRole(vs, role);
    if (!slot) {
      onEvent({ type: 'think', text: `检测到${roleName}需求，但当前组合未挂${roleName}模型。` });
      continue;
    }
    const helperCfg = assembly.slotToModelCfg(slot, vs);
    if (!helperCfg) {
      onEvent({ type: 'think', text: `${roleName}槽位还没有选模型。` });
      continue;
    }
    const helperLabel = helperCfg.model || helperCfg.name || roleName;
    onEvent({ type: 'status', text: `正在用${roleName}模型 ${helperLabel} 生成…` });
    diag.log('agent', '路由到生成槽位', { role, model: helperLabel });
    try {
      if (role === 'docGen') {
        const msg = await completeWithFallback({
          modelCfg: helperCfg,
          messages: [
            { role: 'system', content: assembly.helperPrompt(role, lang) },
            { role: 'user', content: String(userText || '').slice(0, 24000) || '请写一份文档' }
          ],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: (sec) => onEvent({ type: 'status', text: `${roleName}模型处理中 · ${sec}` })
        });
        const out = String(msg?.content || '').trim();
        if (!out) throw new Error('文档模型没有返回内容');
        const rel = writeGeneratedFile(workspace, extra, snap, `generated/doc-${fileStamp()}.md`, out, 'utf8');
        extraTexts.push(`—— 以下是${roleName}模型「${helperLabel}」已写入的文档 ——`);
        extraTexts.push(`文件：${rel}\n\n${out.slice(0, 8000)}`);
        onEvent({ type: 'think', text: `已生成文档 ${rel}` });
        continue;
      }
      const asset = await generate.generateMedia({
        role,
        modelCfg: helperCfg,
        prompt: userText,
        signal
      });
      const rel = writeGeneratedFile(
        workspace,
        extra,
        snap,
        `generated/${role}-${fileStamp()}${asset.ext || '.bin'}`,
        asset.buf
      );
      extraTexts.push(`—— ${roleName}已完成，文件在工作目录：${rel}。请据此继续回答用户，不要说还没生成。 ——`);
      onEvent({ type: 'think', text: `已生成文件 ${rel}` });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      extraTexts.push(`【${roleName}失败】${e.message}`);
      onEvent({ type: 'think', text: `${roleName}失败：${e.message}` });
      diag.log('agent', '生成槽位失败', { role, message: e && e.message });
    }
  }
}

function buildSystemPrompt({ workspace, rules, skill, extra, allSkills, persona, visionMode, visionBridge, lang }) {
  const langInfo = lang || replyLang.fromLocale(store.load().locale);
  const personaText = replyLang.softenForcedChinese(String(persona || '').trim());
  const enPrompt = replyLang.promptInEnglish(langInfo);
  const personaSection = personaText
    ? (enPrompt ? `\n\n## Persona (always follow)\n${personaText}\n` : `\n\n## 人设（必须始终遵守）\n${personaText}\n`)
    : '';
  const ruleText = (rules || []).map((r) => `### ${r.name}\n${replyLang.softenForcedChinese(r.body)}`).join('\n\n');
  const skillText = skill
    ? (enPrompt
      ? `\nThe user selected skill "${skill.name}". Follow it:\n${replyLang.softenForcedChinese(skill.body)}\n`
      : `\n当前用户指定技能「${skill.name}」，必须遵循：\n${replyLang.softenForcedChinese(skill.body)}\n`)
    : '';
  const appSkills = (extra || []).filter((p) => /skills$/i.test(p)).map((p) => p.replace(/\\/g, '/'));
  const catalog = (allSkills || []).map((s) => {
    const loc = s.scope === 'workspace' ? (enPrompt ? 'project' : '项目') : (enPrompt ? 'global' : '全局');
    const pri = s.priority ? (enPrompt ? `priority ${s.priority}` : `优先度${s.priority}`) : '';
    const cover = s.active === false
      ? (enPrompt ? ' (overridden by a higher-priority skill with the same name)' : '（被更高优先度同名技能覆盖，不生效）')
      : '';
    return `- /${s.name} ${pri}（${loc}） ${String(s.file || '').replace(/\\/g, '/')}  ${s.desc || ''} ${cover}`;
  }).join('\n');
  const langLine = replyLang.systemLangLine(langInfo);
  let visionSection = '';
  if (visionMode === 'helper' || visionMode === 'mixed') {
    visionSection += enPrompt
      ? `\nVision combo is on (${visionBridge}). Recognized images appear as text under "image recognition result". Answer from that text. Do not say you cannot see images.\n`
      : `\n已启用看图组合（${visionBridge}）。已识别的图片结果写在用户消息里的「图片识别结果」段。你必须根据这些文字回答画面内容，禁止说自己看不到图、没有看图工具或看图通道未接通。\n`;
  }
  if (visionMode === 'native' || visionMode === 'mixed') {
    visionSection += enPrompt
      ? `\nThis message includes original images. Look at the image_url parts and answer what is in the picture. Do not say you cannot see images.\n`
      : `\n本条消息里带有原图（image_url）。请直接根据画面回答，禁止说自己看不到图或没有看图通道。\n`;
  }
  if (enPrompt) {
    return `${langLine}${personaSection}${visionSection}
Workspace: ${workspace || '(none)'}
You may use tools to read and write files in the workspace, skill folders, and rule folders.
Skill folders:
${appSkills.map((p) => `- ${p}`).join('\n') || '- (none)'}
Installed skills (when asked about a skill, read_file the SKILL.md; do not rely on memory):
${catalog || '- (none)'}
Writes and deletes in the workspace are snapshotted and can be restored.
Say in one or two sentences what you will do, then call tools.
Do not invent unread file contents. After edits, list the files you changed.
Source files must be UTF-8. Never produce mojibake.

## Rules
${ruleText || 'None'}
${skillText}`;
  }
  return `${langLine}${personaSection}${visionSection}
当前工作目录：${workspace || '（未选择）'}
你可以调用工具读写工作目录内的文件，也可以读写技能目录和规则目录。
技能目录：
${appSkills.map((p) => `- ${p}`).join('\n') || '- （无）'}
已安装技能（用户问技能内容时，必须 read_file 读取对应 SKILL.md，不要凭记忆）：
${catalog || '- （还没有技能）'}
写入或删除工作目录文件会自动快照，用户可还原。
先用一两句说明你准备怎么做，再调用工具。
不要编造未读过的文件内容。改完后用短列表说明改了哪些文件。
代码与注释编码必须是 UTF-8，禁止乱码。

## 规则
${ruleText || '无额外规则'}
${skillText}`;
}

const MAX_VISION_IMAGES = 16;
// 一次视觉代理最多识别几张图，避免串行识别过慢
const MAX_VISION_AGENT_IMAGES = 4;
// 单张图片视觉识别超时：本地服务加载模型/处理大图可能较慢，但不能无限等待
const VISION_TIMEOUT_MS = 120 * 1000;

function pushVision(parts, dataUrl) {
  if (!dataUrl) return false;
  const n = parts.filter((p) => p.type === 'image_url').length;
  if (n >= MAX_VISION_IMAGES) return false;
  parts.push({ type: 'image_url', image_url: { url: dataUrl } });
  return true;
}

async function attachmentsToParts(attachments, { vision, signal, noVisionHint, skipImageNote } = {}) {
  const parts = [];
  const extraTexts = [];
  const hint = noVisionHint || '当前模型不支持看图。';
  const skippedImages = [];
  for (const att of attachments || []) {
    const parsed = await parseAttachment(att.path, { signal });
    extraTexts.push(`附件「${parsed.name}」类型：${parsed.kind}`);
    if (parsed.text) extraTexts.push(`----- ${parsed.name} -----\n${parsed.text}`);
    if (parsed.dataUrl) {
      if (vision) pushVision(parts, parsed.dataUrl);
      else {
        skippedImages.push(parsed.dataUrl);
        if (!skipImageNote) extraTexts.push(`用户附上了图片「${parsed.name}」，但你只能看到文件名。${hint}`);
      }
    }
    if (parsed.images?.length) {
      if (vision) {
        let sent = 0;
        for (const img of parsed.images) {
          if (pushVision(parts, img.dataUrl)) sent++;
        }
        extraTexts.push(`${parsed.kind === 'video' ? '视频' : '文档'}「${parsed.name}」已附上 ${sent} 张图。`);
      } else {
        for (const img of parsed.images) skippedImages.push(img.dataUrl);
        if (!skipImageNote) extraTexts.push(`${parsed.kind === 'video' ? '视频' : '文档'}「${parsed.name}」含 ${parsed.images.length} 张图，但你看不到画面。${hint}`);
      }
    }
  }
  return { parts, extraTexts, skippedImages };
}

function modelSupportsVision(modelCfg) {
  // 本地 GGUF 主模型走的是内置引擎的文本通道，不直接接收图片；
  // 主模型不支持看图时，由「模型组合」里的看图槽位负责识别图片。
  if (isLocalGguf(modelCfg)) return false;
  // 用户在「视觉设置」里明确指定过开关时，以开关为准
  if (typeof modelCfg?.vision === 'boolean') return modelCfg.vision;
  const id = `${modelCfg?.model || ''} ${modelCfg?.name || ''}`.toLowerCase();
  return /vl|vision|llava|pixtral|moondream|minicpm-v|gpt-4o|gpt-4\.1|claude|gemini|qwen2\.5-vl|qwen3-vl/.test(id);
}

function noVisionHint(modelCfg) {
  return isLocalGguf(modelCfg)
    ? '本地模型走内置引擎的文本通道，不支持直接看图。要识别画面，请在「文件 → 模型组合」中给当前主模型挂上看图模型。'
    : '要识别画面请换成视觉模型（如 gpt-4o、qwen2.5-vl），或在「模型组合」中挂上看图模型。';
}

/** 本地引擎没把像素喂进去时，模型会用这类套话冒充「识别结果」 */
function isBlindVisionText(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length > 800) return false;
  return /无法直接访问或识别图片|无法提取文字或分析画面|看不到(这张)?图|没有看到(任何)?(图片|画面)|cannot directly access or recognize|can'?t see (the )?image|do not (actually )?see (any )?(the )?image|no image (was |is )?provided|没有收到图片|未提供图片|没有看到图片/i.test(s);
}

async function callVisionEndpoint({ endpoint, model, dataUrl, signal, onWait, lang }) {
  const url = `${String(endpoint).replace(/\/$/, '')}/chat/completions`;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, VISION_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  onWait?.('正在请求本地看图端点…');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: String(model || '').replace(/\.gguf$/i, '') || model || '',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: replyLang.visionAsk(lang || replyLang.fromLocale(store.load().locale)) },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ]
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`看图端点请求失败 ${res.status}：${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = asText(data.choices?.[0]?.message?.content);
    if (!text) throw new Error('看图端点返回了空内容');
    return text;
  } catch (e) {
    if (timedOut) {
      const err = new Error(`看图端点超时（${VISION_TIMEOUT_MS / 1000} 秒）。请确认该地址已加载看图模型，或把端点留空改用内置看图引擎。`);
      err.code = 'vision_timeout';
      throw err;
    }
    if (e.name === 'AbortError') {
      const stopped = !!(signal && signal.aborted);
      const err = new Error(stopped ? '已停止' : '看图端点请求中断');
      err.name = 'AbortError';
      err.code = stopped ? 'aborted' : 'vision_timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 看图：本地 GGUF + mmproj 走内置 llama-server（自动下载）；端点仅作可选兜底。
async function visionRecognize({ model, mmproj: mmprojPath, endpoint, dataUrl, signal, onWait, lang }) {
  const vs = store.load();
  const dir = vs.modelsDir || store.defaultModelsDir();
  const file = localLlm.resolveGgufPath({ model, modelPath: '' }, dir);
  const say = (info) => onWait?.(info);
  const ep = endpoint && /^https?:\/\//i.test(endpoint) ? endpoint : '';
  let lastErr = null;

  if (file) {
    let projector = mmprojPath;
    try {
      projector = await mmproj.ensure(file, mmprojPath, say);
    } catch (e) {
      diag.log('vision', '自动准备投影文件失败', { message: e && e.message });
      projector = '';
    }
    if (projector) {
      try {
        const text = await visionEngine.describe({
          modelPath: file,
          mmproj: projector,
          model,
          dataUrl,
          signal,
          onWait: say,
          lang
        });
        if (!isBlindVisionText(text)) {
          diag.log('vision', '内置看图引擎识别成功', { 字符: text.length });
          return text;
        }
        lastErr = new Error('内置看图引擎没有真正看到画面');
        diag.log('vision', '内置看图引擎未看到画面', { preview: String(text).slice(0, 160) });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        diag.log('vision', '内置看图引擎失败', { message: e && e.message });
      }
    } else {
      lastErr = new Error('缺少 mmproj，无法把图片送进看图模型');
    }
  }

  if (ep) {
    try {
      const text = await callVisionEndpoint({ endpoint: ep, model, dataUrl, signal, onWait: say, lang });
      if (!isBlindVisionText(text)) {
        diag.log('vision', '看图端点识别成功', { endpoint: ep, 字符: text.length });
        return text;
      }
      lastErr = lastErr || new Error('看图端点没有真正看到画面');
      diag.log('vision', '看图端点未看到画面', { preview: String(text).slice(0, 160) });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = lastErr || e;
      diag.log('vision', '看图端点失败', { message: e && e.message });
    }
  }

  const err = new Error(
    lastErr?.message
      ? `看图失败：${lastErr.message}`
      : `本地视觉模型「${model || '未配置'}」无法识别图片。请在「模型组合」挂上支持视觉的 GGUF 和 mmproj。`
  );
  err.code = 'vision_unsupported';
  throw err;
}

function visionWait(onEvent) {
  return (info) => {
    const text = typeof info === 'number' ? `视觉识别中 · ${info} 秒` : String(info || '正在识别图片…');
    onEvent?.({ type: 'status', text });
  };
}

async function describeImageFile(abs, { signal, onEvent, lang }) {
  const parsed = await parseAttachment(abs, { signal });
  const dataUrl = parsed.dataUrl || parsed.images?.[0]?.dataUrl;
  if (!dataUrl) return `图片「${path.basename(abs)}」无法读取为图像数据。`;
  const vis = assembly.visionFrom(store.load());
  if (!vis.model) {
    return `图片「${path.basename(abs)}」已找到，但当前没有可用的看图模型。请在「文件 → 模型组合」里挂上看图模型。`;
  }
  onEvent?.({ type: 'status', text: `正在用看图模型识别 ${path.basename(abs)}…` });
  const text = await visionRecognize({
    model: vis.model,
    mmproj: vis.mmproj,
    endpoint: vis.endpoint,
    dataUrl,
    signal,
    onWait: visionWait(onEvent),
    lang: lang || replyLang.fromLocale(store.load().locale)
  });
  if (isBlindVisionText(text)) {
    diag.log('vision', '看图模型未真正看到画面', { file: path.basename(abs), preview: text.slice(0, 160) });
    return `图片「${path.basename(abs)}」本地看图未看到画面。请确认看图槽位挂的是带 mmproj 的视觉 GGUF。`;
  }
  return `【图片识别结果：${path.basename(abs)}】\n${text}`;
}

function flattenMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const text = m.content.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      if (p?.type === 'image_url') return '[图片附件]';
      return '';
    }).filter(Boolean).join('\n');
    return { ...m, content: text };
  });
}

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((p) => p?.text || p?.content || '').join('');
  return String(value);
}

function extractReason(obj) {
  return asText(obj?.reasoning_content || obj?.reasoning || obj?.thinking || '');
}

function applyToolDelta(toolCalls, deltaCalls) {
  for (const tc of deltaCalls || []) {
    const idx = tc.index ?? toolCalls.length;
    if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) toolCalls[idx].id = tc.id;
    if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
  }
}

function consumeChunk(json, acc, onDelta, onReason) {
  const choice = json.choices?.[0] || {};
  const delta = choice.delta || {};
  const piece = asText(delta.content);
  if (piece) {
    acc.content += piece;
    onDelta(piece);
  }
  const reason = extractReason(delta);
  if (reason) {
    acc.reason += reason;
    onReason(reason);
  }
  if (delta.tool_calls) applyToolDelta(acc.toolCalls, delta.tool_calls);
  if (!choice.delta && json.message) {
    const full = asText(json.message.content);
    if (full.length > acc.content.length) {
      const extra = full.slice(acc.content.length);
      acc.content = full;
      if (extra) onDelta(extra);
    }
    const nativeReason = extractReason(json.message);
    if (nativeReason.length > acc.reason.length) {
      const extraR = nativeReason.slice(acc.reason.length);
      acc.reason = nativeReason;
      if (extraR) onReason(extraR);
    }
    if (json.message.tool_calls) acc.toolCalls = json.message.tool_calls;
  }
}

function finishMessage(acc) {
  const msg = { role: 'assistant', content: acc.content || '' };
  if (acc.reason) msg.reasoning_content = acc.reason;
  const toolCalls = (acc.toolCalls || []).filter(Boolean);
  if (toolCalls.length) {
    msg.tool_calls = toolCalls;
    msg.tool_calls.forEach((t, i) => {
      if (!t.id) t.id = `call_${i}`;
      t.type = t.type || 'function';
    });
    if (!msg.content) msg.content = null;
  }
  return msg;
}

function isLocalGguf(modelCfg) {
  if (!modelCfg) return false;
  if (modelCfg.type === 'local') return true;
  if (modelCfg.modelPath) return true;
  return /\.gguf$/i.test(String(modelCfg.model || ''));
}

async function completeOnce({ modelCfg, messages, stream, onDelta, onReason, signal, useTools = true, onWait }) {
  onDelta = onDelta || (() => {});
  onReason = onReason || (() => {});
  onWait = onWait || (() => {});
  if (isLocalGguf(modelCfg)) {
    return localLlm.complete({
      modelCfg,
      modelsDir: store.load().modelsDir || store.defaultModelsDir(),
      messages,
      onDelta,
      onReason,
      signal,
      onWait,
      tools: useTools ? toolsSpec() : null
    });
  }
  const url = `${String(modelCfg.baseUrl).replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: modelCfg.model,
    messages,
    stream: !!stream
  };
  if (useTools) body.tools = toolsSpec();
  const headers = { 'Content-Type': 'application/json' };
  if (modelCfg.apiKey) headers.Authorization = `Bearer ${modelCfg.apiKey}`;

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // 首包前不因空闲 abort（长上下文/工具后等模型容易超过 3 分钟）；用户停止仍立刻 abort
  const IDLE_CHUNK_MS = 180 * 1000; // 已出包后 chunk 间隔，防止流真正卡住
  const OVERALL_MS = 30 * 60 * 1000; // 单次模型请求整体兜底
  const overallTimer = setTimeout(() => ctl.abort(), OVERALL_MS);
  const startAt = Date.now();
  let gotFirst = false;
  let idleTimer = null;
  let lastChunkAt = 0;
  // 心跳：首包前播报等待秒数；首包后若超过 30 秒无新内容，播报「仍在等待」，让长思考停顿可见
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (!gotFirst) {
      onWait(Math.floor((now - startAt) / 1000));
    } else if (lastChunkAt && now - lastChunkAt > 30000) {
      onWait(`已 ${Math.floor((now - lastChunkAt) / 1000)} 秒无新输出，模型可能仍在思考…`);
    }
  }, 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = `模型请求失败 ${res.status}：${t.slice(0, 500)}`;
      if (res.status === 404 && /not found/i.test(t)) {
        msg = `接口没有这个模型「${modelCfg.model}」。请换一个模型 ID，或检查接口地址。`;
      }
      if (res.status === 400 && /image_url/i.test(t)) {
        msg = '当前模型不支持看图，请换视觉模型，或只发文字/文档。';
        const err2 = new Error(msg);
        err2.status = 400;
        err2.code = 'no_vision';
        throw err2;
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    if (!stream) {
      const data = await res.json();
      const message = data.choices?.[0]?.message || { role: 'assistant', content: '' };
      const reason = extractReason(message);
      if (reason) onReason(reason);
      if (message.content) onDelta(asText(message.content));
      return message;
    }

    const acc = { content: '', reason: '', toolCalls: [] };
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!gotFirst) gotFirst = true;
      lastChunkAt = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctl.abort(), IDLE_CHUNK_MS);
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        let s = line.trim();
        if (!s) continue;
        if (s.startsWith('data:')) s = s.slice(5).trim();
        if (s === '[DONE]') continue;
        if (!s.startsWith('{')) continue;
        let json;
        try {
          json = JSON.parse(s);
        } catch {
          continue;
        }
        consumeChunk(json, acc, onDelta, onReason);
      }
    }
    if (buf.trim().startsWith('{')) {
      try {
        consumeChunk(JSON.parse(buf.trim()), acc, onDelta, onReason);
      } catch {
        /* 忽略结尾残片 */
      }
    }
    return finishMessage(acc);
  } catch (e) {
    if (e.name === 'AbortError') {
      const stopped = !!(signal && signal.aborted);
      const err = new Error(stopped ? '已停止' : '模型响应超时，长时间没有输出。请检查本地模型是否卡住。');
      err.name = 'AbortError';
      err.code = stopped ? 'aborted' : 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function hasOutput(msg) {
  return !!(asText(msg?.content).trim() || msg?.tool_calls?.length);
}

async function completeWithFallback(opts) {
  const noTools = !!opts.noTools;
  if (isLocalGguf(opts.modelCfg)) {
    let lastErr;
    for (const useTools of (noTools ? [false] : [true, false])) {
      try {
        const msg = await completeOnce({ ...opts, stream: true, useTools });
        if (hasOutput(msg)) return msg;
        lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        if (/未找到本地 GGUF/.test(String(e.message || ''))) throw e;
      }
    }
    throw lastErr || new Error('模型没有返回内容');
  }
  const tries = noTools
    ? [
      { stream: true, useTools: false },
      { stream: false, useTools: false }
    ]
    : [
      { stream: true, useTools: true },
      { stream: false, useTools: true },
      { stream: true, useTools: false },
      { stream: false, useTools: false }
    ];
  let lastErr;
  for (const mode of tries) {
    try {
      const msg = await completeOnce({ ...opts, ...mode });
      if (hasOutput(msg)) return msg;
      lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
    } catch (e) {
      if (e.name === 'AbortError') throw e; // 超时/停止不再重试
      lastErr = e;
      if (e.code === 'no_vision' && Array.isArray(opts.messages?.[opts.messages.length - 1]?.content)) {
        diag.log('agent', '接口不接受图片，改为纯文字重试', { model: opts.modelCfg?.model });
        opts = { ...opts, messages: flattenMessages(opts.messages) };
        continue;
      }
    }
  }
  throw lastErr || new Error('模型没有返回内容');
}

async function agentLoop({ modelCfg, messages, workspace, extra, snap, onEvent, signal, lang }) {
  const toolLabel = {
    list_dir: '查看目录',
    read_file: '读取文件',
    write_file: '写入文件',
    delete_file: '删除文件',
    search_text: '搜索代码'
  };
  let finalText = '';
  let answered = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('已停止');
    onEvent({ type: 'think', text: round === 0 ? '正在思考...' : '根据工具结果继续思考...' });
    onEvent({ type: 'status', text: '正在调用模型…' });
    diag.log('agent', '请求模型', { round, model: modelCfg.model, 消息条数: messages.length });
    const msg = await completeWithFallback({
      modelCfg,
      messages,
      onDelta: (t) => onEvent({ type: 'text', text: t }),
      onReason: (t) => onEvent({ type: 'reason', text: t }),
      onWait: (sec) => onEvent({ type: 'status', text: `正在等待模型响应 · ${sec}` }),
      signal
    });
    diag.log('agent', '模型已返回', { round, 工具调用数: (msg.tool_calls || []).length });
    messages.push(msg);
    if (asText(msg.content)) finalText = asText(msg.content);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      answered = true;
      break;
    }

    for (const tc of calls) {
      const name = tc.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const detail = args.path || args.query || '';
      onEvent({
        type: 'tool',
        name,
        status: 'running',
        detail,
        text: `${toolLabel[name] || name}${detail ? ` ${detail}` : ''}`
      });
      let result;
      const startedAt = Date.now();
      diag.log('agent', '开始执行工具', { round, name, detail: String(detail).slice(0, 200) });
      try {
        result = await execTool(workspace, snap, name, args, onEvent, extra, signal, lang);
        diag.log('agent', '工具执行完成', { name, 耗时毫秒: Date.now() - startedAt, 结果字符数: String(result || '').length });
      } catch (e) {
        result = `工具失败：${e.message}`;
        diag.log('agent', '工具执行失败', { name, 耗时毫秒: Date.now() - startedAt, message: e && e.message });
      }
      onEvent({
        type: 'tool',
        name,
        status: 'done',
        detail,
        text: `完成：${toolLabel[name] || name}${detail ? ` ${detail}` : ''}`
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: String(result).slice(0, 40000)
      });
    }
  }

  if (!answered && !signal?.aborted) {
    onEvent({ type: 'status', text: '正在整理最终回答…' });
    messages.push({
      role: 'user',
      content: '工具调用次数已用完。请根据已经拿到的信息直接写出完整的最终回答，不要再调用任何工具。'
    });
    try {
      const finalMsg = await completeWithFallback({
        modelCfg,
        messages,
        noTools: true,
        onDelta: (t) => onEvent({ type: 'text', text: t }),
        onReason: (t) => onEvent({ type: 'reason', text: t }),
        onWait: (sec) => onEvent({ type: 'status', text: `正在等待模型响应 · ${sec}` }),
        signal
      });
      const text = asText(finalMsg.content);
      if (text) finalText = text;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      onEvent({ type: 'think', text: `收尾回答失败：${e.message}` });
    }
  }
  return finalText;
}

async function runTurn({
  workspace,
  appRoot,
  modelCfg,
  history,
  userText,
  attachments,
  contextPaths,
  skill,
  rules,
  allSkills,
  onEvent,
  signal
}) {
  if (!modelCfg) {
    throw new Error('请先选择模型');
  }
  if (isLocalGguf(modelCfg)) {
    const dir = store.load().modelsDir || store.defaultModelsDir();
    if (!localLlm.resolveGgufPath(modelCfg, dir)) {
      throw new Error('未找到本地 GGUF 模型。请把 .gguf 文件放到本地模型目录，并在输入框旁选择。');
    }
  } else if (!modelCfg.baseUrl || !modelCfg.model) {
    throw new Error('请先在设置中配置 API 模型');
  }

  const extra = extraRoots(appRoot, workspace);
  const persona = skillsLib.loadPersona(appRoot).body || '';
  const snap = { current: null };
  const vs = store.load();
  const vis = assembly.visionFrom(vs);
  const lang = replyLang.resolve({ locale: vs.locale, userText, history });
  // 挂了看图槽位就走辅助模型；不要因为接口「支持看图」开关把组装的模型跳过
  const useHelper = !!(vis.model);
  const vision = modelSupportsVision(modelCfg) && !useHelper;
  const visionHint = noVisionHint(modelCfg);
  if (attachments && attachments.length) onEvent({ type: 'status', text: '正在解析附件…' });
  const { parts, extraTexts, skippedImages } = await attachmentsToParts(attachments, {
    vision,
    signal,
    noVisionHint: visionHint,
    skipImageNote: useHelper
  });
  if (skippedImages.length && !useHelper) {
    onEvent({ type: 'think', text: `当前模型看不到图片，已改为文字说明。${visionHint}` });
  }
  const ctxChunks = [];
  if (contextPaths && contextPaths.length) onEvent({ type: 'status', text: '正在读取引用文件…' });
  for (const p of contextPaths || []) {
    try {
      const abs = resolveAllowed(workspace, extra, p);
      const ext = path.extname(abs).toLowerCase();
      if (isImageExt(ext)) {
        const parsed = await parseAttachment(abs, { signal });
        if (parsed.dataUrl) {
          if (vision) pushVision(parts, parsed.dataUrl);
          else skippedImages.push(parsed.dataUrl);
        }
        ctxChunks.push(`@${p}（图片文件）`);
        continue;
      }
      if (isDocumentExt(ext)) {
        const parsed = await parseAttachment(abs, { signal });
        ctxChunks.push(`@${p}\n${parsed.text || ''}`);
        if (parsed.images?.length) {
          if (vision) {
            for (const img of parsed.images) pushVision(parts, img.dataUrl);
          } else {
            for (const img of parsed.images) skippedImages.push(img.dataUrl);
            ctxChunks.push(`（文档内含 ${parsed.images.length} 张图，你看不到画面。${visionHint}）`);
          }
        }
      } else {
        ctxChunks.push(`@${p}\n${readTextLimited(abs)}`);
      }
    } catch (e) {
      ctxChunks.push(`@${p} 读取失败：${e.message}`);
    }
  }

  if (skippedImages.length && vis.model) {
    const label = vis.model;
    const list = skippedImages.slice(0, MAX_VISION_AGENT_IMAGES);
    onEvent({ type: 'status', text: `正在用看图模型 ${label} 识别图片（共 ${list.length} 张）…` });
    diag.log('agent', '路由到看图模型', { model: label, 端点: vis.endpoint || '', 张数: list.length });
    const visionResults = [];
    const failNotes = [];
    for (let i = 0; i < list.length; i++) {
      const dataUrl = list[i];
      onEvent({ type: 'status', text: `正在识别第 ${i + 1}/${list.length} 张图片…` });
      try {
        const text = await visionRecognize({
          model: label,
          mmproj: vis.mmproj,
          endpoint: vis.endpoint,
          dataUrl,
          signal,
          onWait: visionWait(onEvent),
          lang
        });
        visionResults.push(`【图片识别结果】\n${text}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        diag.log('vision', '看图失败', { message: e && e.message });
        failNotes.push(e.message || String(e));
      }
    }
    if (visionResults.length) {
      extraTexts.push('—— 以下是看图模型对图片的识别内容（仅文字，无画面） ——');
      extraTexts.push(visionResults.join('\n\n'));
    }
    if (failNotes.length && !visionResults.length) {
      extraTexts.push(`【图片识别失败】${failNotes[0]}`);
    }
  }

  await runGenerateSlots({ vs, userText, workspace, extra, extraTexts, onEvent, signal, snap, lang });

  const helperRoles = assembly.detectRoles(userText, {
    hasImages: skippedImages.length > 0,
    contextChars: ctxChunks.join('\n').length + extraTexts.join('\n').length
  }).filter((r) => assembly.TEXT_HELPER_IDS.includes(r));
  for (const role of helperRoles) {
    const slot = assembly.slotByRole(vs, role);
    if (!slot) continue;
    const helperCfg = assembly.slotToModelCfg(slot, vs);
    if (!helperCfg) continue;
    const sameAsPrimary = isLocalGguf(helperCfg) && isLocalGguf(modelCfg)
      ? (helperCfg.model || helperCfg.modelPath) === (modelCfg.model || modelCfg.modelPath)
      : helperCfg.id && helperCfg.id === modelCfg.id;
    if (sameAsPrimary) continue;
    const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
    const helperLabel = helperCfg.model || helperCfg.name || role;
    onEvent({ type: 'status', text: `正在用${roleName}模型 ${helperLabel} 预处理…` });
    diag.log('agent', '路由到辅助模型', { role, model: helperLabel });
    try {
      const material = [userText, extraTexts.join('\n\n'), ctxChunks.join('\n\n')].filter(Boolean).join('\n\n').slice(0, 24000);
      const msg = await completeWithFallback({
        modelCfg: helperCfg,
        messages: [
          { role: 'system', content: assembly.helperPrompt(role, lang) },
          { role: 'user', content: material || '请根据材料给出结果' }
        ],
        noTools: true,
        signal,
        onDelta: () => {},
        onWait: (sec) => onEvent({ type: 'status', text: `${roleName}模型处理中 · ${sec}` })
      });
      const out = String(msg?.content || '').trim();
      if (out) {
        extraTexts.push(`—— 以下是${roleName}模型「${helperLabel}」的结果，供你继续完成原任务 ——`);
        extraTexts.push(out);
        onEvent({ type: 'think', text: `已接入${roleName}模型 ${helperLabel}` });
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      extraTexts.push(`【${roleName}模型失败】${e.message}`);
      diag.log('agent', '辅助模型失败', { role, message: e && e.message });
    }
  }

  onEvent({ type: 'think', text: '正在判断是否需要联网搜索…' });
  if (webSearch.needsWebSearch(userText, {
    contextChars: ctxChunks.join('\n').length,
    hasImages: skippedImages.length > 0
  })) {
    onEvent({ type: 'status', text: '正在联网搜索…' });
    onEvent({ type: 'think', text: '需要上网核实，正在搜索（本轮一次）…' });
    try {
      const found = await webSearch.search({ query: userText, sites: vs.searchSites, signal });
      const block = webSearch.formatBlock(found, lang);
      if (block) {
        extraTexts.unshift(block);
        onEvent({ type: 'think', text: `已注入 ${found.hits.length} 条搜索结果，开始思考` });
        diag.log('agent', '联网搜索已注入', { 条数: found.hits.length, query: found.query });
      } else {
        onEvent({ type: 'think', text: '联网搜索没有可用结果，开始思考' });
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', '联网搜索失败', { message: e && e.message });
      onEvent({ type: 'think', text: `联网搜索失败：${e.message}，开始思考` });
    }
  } else {
    onEvent({ type: 'think', text: '无需联网，开始思考' });
  }

  const hasNativeImages = parts.some((p) => p.type === 'image_url');
  const hasHelperText = extraTexts.some((t) => t.includes('【图片识别结果】'));
  const visionMode = hasHelperText && hasNativeImages ? 'mixed' : hasNativeImages ? 'native' : hasHelperText ? 'helper' : '';

  const userContent = [];
  const textBlock = [userText, extraTexts.join('\n\n'), ctxChunks.join('\n\n')].filter(Boolean).join('\n\n');
  if (parts.length) {
    userContent.push({ type: 'text', text: textBlock || '请查看附件' });
    userContent.push(...parts);
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt({ workspace, rules, skill, extra, allSkills, persona, visionMode, visionBridge: vis.model || '', lang }) },
    ...history.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.text || ''
    })),
    { role: 'user', content: parts.length ? userContent : textBlock }
  ];

  onEvent({ type: 'think', text: `正在调用 ${modelCfg.model}...` });
  const finalText = await agentLoop({ modelCfg, messages, workspace, extra, snap, onEvent, signal, lang });

  const changes = snap.current?.manifest?.changes || [];
  if (snap.current && changes.length) {
    snapshot.captureAfter(workspace, snap.current);
    onEvent({
      type: 'files',
      snapshotId: snap.current.id,
      changes
    });
  }
  onEvent({ type: 'done', text: finalText, snapshotId: snap.current?.id || null, changes });
  return { text: finalText, snapshotId: snap.current?.id || null, changes };
}

function listSkills(appRoot, workspace, order) {
  return skillsLib.loadAll(path.join(appRoot, 'skills'), workspace, order);
}

function listRules(appRoot, workspace) {
  return skillsLib.loadRules(path.join(appRoot, 'rules'), workspace);
}

module.exports = { runTurn, listSkills, listRules, toolsSpec };

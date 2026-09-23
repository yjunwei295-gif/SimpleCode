const fs = require('fs');
const path = require('path');
const { safeJoin, resolveAllowed, resolveRead, extraRoots, listTree, readTextFile, readLineRange, isInside, SKIP } = require('./workspace');
const snapshot = require('./snapshot');
const skillsLib = require('./skills');
const { parseAttachment, isDocumentExt, isImageExt } = require('./media');
const localLlm = require('./local-llm');
const zbaingAi = require('./zbaingAi');
const store = require('./store');
const diag = require('./diag');
const assembly = require('./assembly');
const mmproj = require('./mmproj');
const visionEngine = require('./vision-engine');
const replyLang = require('./reply-lang');
const webSearch = require('./web-search');
const generate = require('./generate');
const memory = require('./memory');
const memoryGlobal = require('./memory-global');
const compact = require('./context-compact');
const retrieve = require('./memory-retrieve');
const codeIndex = require('./code-index');
const codeEmbed = require('./code-embed');
const typecheck = require('./typecheck');
const apiProtocol = require('./api-protocol');
const sandbox = require('./sandbox');
const toolXml = require('./tool-xml');
// 看图端点请求统一走 httpFetch（Electron net.fetch，与聊天主链路同用系统代理），避免裸 fetch 在代理环境下 fetch failed
const { httpFetch } = require('./http-fetch');

const DEFAULT_MAX_ROUNDS = 16;
const SAFETY_MAX_ROUNDS = 128;

function toolsSpec() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出目录。不传 path 时列出工作目录和已添加的附加目录；path 可以是工作区内相对路径，也可以是任意绝对路径（不必在当前项目内）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '可选。要列出的目录，支持绝对路径' },
            query: { type: 'string', description: '可选，按路径或文件名过滤' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文本或解析 Word/Excel/PPT/PDF。path 可以是工作区内相对路径，也可以是任意绝对路径（不必在当前项目内）。源码文件先用消息里的【项目地图】或 map_lookup 拿到方法行号，再传 startLine/endLine 只读片段，避免整文件读浪费上下文。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径或绝对路径' },
            startLine: { type: 'integer', description: '可选。起始行（1 起），与 endLine 配合只读片段' },
            endLine: { type: 'integer', description: '可选。结束行（含）' }
          },
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
        name: 'create_dir',
        description: '在工作目录、附加目录或技能/规则目录内新建文件夹。可一次创建多层（如 a/b/c）。已存在则直接成功。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要创建的文件夹，相对路径或允许范围内的绝对路径' }
          },
          required: ['path']
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
        description: '按关键字精确搜索源码文本（符号、字符串、报错原文）。不传 path 时搜工作目录和已添加的附加目录。找某功能在哪实现请先用 map_lookup 查项目地图。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            glob: { type: 'string', description: '可选扩展名，如 .js' },
            path: { type: 'string', description: '可选。要搜索的目录，支持绝对路径' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'semantic_search',
        description: '按语义在本地向量索引里找相关代码片段。不知道符号名、只知道意图时用它。精确符号用 search_text，已知方法名用 goto_definition。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言，如“登录后如何保存会话”' },
            path: { type: 'string', description: '可选。只在该目录内检索，支持绝对路径' },
            limit: { type: 'integer', description: '返回条数，默认 8，最大 16' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'goto_definition',
        description: '按符号名跳到定义。返回项目地图里该符号的文件、行号和附近源码。同名多处会都列出来。',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '要跳转的符号名，如函数名、类名' }
          },
          required: ['symbol']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'map_lookup',
        description: '查项目地图：按关键字返回命中模块的依赖、方法名、方法说明与行号。定位功能实现的首选；传 module 可拿该模块全部方法。拿到行号后用 read_file 的 startLine/endLine 只读片段。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键字（方法名、模块名、功能词，空格分隔多个）' },
            module: { type: 'string', description: '可选。模块路径（如 electron/lib/agent.js），传了则返回该模块全部方法与依赖' },
            path: { type: 'string', description: '可选。只在该目录内检索' },
            limit: { type: 'integer', description: '返回模块条数，默认 10，最大 30' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_list',
        description: '列出当前项目的防回归记忆（已确认约定/勿破坏项）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_add',
        description: '写入一条项目约定记忆，供以后改相关功能时遵守',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话：原因+结论' },
            paths: { type: 'array', items: { type: 'string' }, description: '相关相对路径' },
            tags: { type: 'array', items: { type: 'string' } },
            pinned: { type: 'boolean', description: '是否每轮强制注入，默认 true' }
          },
          required: ['summary']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_forget',
        description: '删除一条项目长期记忆',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'working_memory_update',
        description: '更新本会话工作记忆（目标、未决问题、焦点文件、临时要点）',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            openQuestions: { type: 'array', items: { type: 'string' } },
            focusPaths: { type: 'array', items: { type: 'string' } },
            scratch: { type: 'array', items: { type: 'string' } },
            addScratch: { type: 'string' },
            addQuestion: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: '需求含糊、会破坏已确认约定、或有多种实现时，必须先向用户提问并等待回答，再改文件',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问用户的问题' },
            options: { type: 'array', items: { type: 'string' }, description: '可选选项' },
            allowFreeText: { type: 'boolean', description: '是否允许自由输入，默认 true' }
          },
          required: ['question']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: '在项目命令沙盒中执行 shell 命令（cwd 限制在工作区内，拦截高危命令，有超时）。用于跑测试、构建、查看 git 状态等；不要用它改系统或删盘。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令，如 npm test 或 git status' },
            cwd: { type: 'string', description: '相对工作区的子目录，默认 .' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'screen_look',
        description: '看当前屏幕。全屏截图后交给看图模型理解，命名并存到本地（最多 50 张，超出删最早的）。返回画面尺寸和图内坐标说明。需要用户打开「活过来」。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clipboard_look',
        description: '从剪贴板导入图片，交给看图模型理解并保存。剪贴板里没有图片时会说明。需要「活过来」开着。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_move',
        description: '把虚拟光标移到截图里的坐标。不移动用户的系统鼠标。x,y 是 screen_look 图内坐标，左上角为 0,0。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '图内横坐标' },
            y: { type: 'number', description: '图内纵坐标' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_click',
        description: '在截图坐标处点击一下。会短暂使用系统鼠标并立刻放回原处。button 为 left、right 或 middle。times 为 2 表示双击。画线、画圆不要用点击，用 mouse_drag。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            button: { type: 'string', description: 'left、right 或 middle，默认 left' },
            times: { type: 'integer', description: '1 单击，2 双击' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_drag',
        description: '按住鼠标沿点拖动再松开，用来画线、画圆。points 至少两个图内坐标，格式 [{x,y},...]。画圆时自己算一圈采样点，从起点拖回起点。会短暂使用系统鼠标并立刻放回原处。',
        parameters: {
          type: 'object',
          properties: {
            points: { type: 'array', description: '图内坐标，按拖动顺序', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } },
            button: { type: 'string', description: 'left、right 或 middle，默认 left' }
          },
          required: ['points']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_scroll',
        description: '在截图坐标处滚动。delta 正数向上，负数向下，约 -120 为一格。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            delta: { type: 'number', description: '滚轮量，负数向下' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'keyboard_type',
        description: '向当前焦点窗口粘贴一段文字。会暂时占用剪贴板，粘贴后放回。需要「活过来」开着。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文字' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'keyboard_key',
        description: '按下组合键，例如 enter、tab、escape、ctrl+c、alt+tab。需要「活过来」开着。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '键名，组合用加号连接' }
          },
          required: ['key']
        }
      }
    }
  ];
}

const HAND_OFF_TOOLS = new Set(['write_file', 'create_dir', 'delete_file', 'run_command']);

function callWorkerTool(roles) {
  return {
    type: 'function',
    function: {
      name: 'call_worker',
      description: '把改文件、建目录、删文件、跑命令交给已配置的实现模型。你只思考和验收。task 必须写到实现模型不用再猜：文件路径、方法名和行号、现在的行为、要改成的行为、不要动的范围。一句笼统要求会被退回。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: roles, description: '实现分工，改代码用 code' },
          task: { type: 'string', description: '实现说明：路径、方法与行号、现状、目标行为、禁止改动的范围' }
        },
        required: ['role', 'task']
      }
    }
  };
}

const WORKER_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'create_dir',
  'delete_file',
  'search_text',
  'goto_definition',
  'run_command'
]);

// brain：有实现模型时不给写文件工具，改由 call_worker 转交。worker：只留改代码要用的工具，避免把整份工具表和语义索引再跑一遍
function toolsFor(kind, workerRoles) {
  const all = toolsSpec();
  if (kind === 'worker') return all.filter((t) => WORKER_TOOL_NAMES.has(t.function?.name));
  if (kind === 'brain' && workerRoles && workerRoles.length) {
    return all.filter((t) => !HAND_OFF_TOOLS.has(t.function?.name)).concat(callWorkerTool(workerRoles));
  }
  return all;
}

// 搜索时跳过的二进制/大体积格式，避免把模型权重、压缩包整个读进内存
const SEARCH_SKIP_EXT = new Set([
  '.gguf', '.bin', '.safetensors', '.pt', '.onnx', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.iso', '.pdf', '.mp4', '.mov', '.avi', '.mkv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.woff', '.woff2', '.ttf'
]);
// 单个文件超过这个大小就不参与文本搜索
const SEARCH_MAX_BYTES = 1024 * 1024;

function searchText(root, query, globExt, signal) {
  const hits = [];
  const q = String(query || '').toLowerCase();
  let seen = 0;
  async function walk(dir, depth) {
    if (signal?.aborted) throw abortErr();
    if (hits.length >= 40 || depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= 40) return;
      if (signal?.aborted) throw abortErr();
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
      } else {
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
      seen += 1;
      // 每扫几十项就把主进程让出来，窗口能刷新。扫过的文件和命中条数不变
      if (seen % 30 === 0) await new Promise((r) => setImmediate(r));
    }
  }
  return walk(root, 0).then(() => hits.join('\n') || '无匹配');
}

async function execTool(workspace, snap, name, args, onEvent, extra, signal, lang) {
  extra = extra || [];
  if (name === 'mkdir') name = 'create_dir';
  if (name === 'list_dir') {
    const q = args.query || '';
    const target = String(args.path || '').trim();
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      const st = fs.statSync(abs);
      const dir = st.isDirectory() ? abs : path.dirname(abs);
      const files = listTree(dir, { query: q, max: 400 });
      return files.map((f) => path.join(dir, f.path).replace(/\\/g, '/')).join('\n') || '(空目录)';
    }
    const chunks = [];
    if (workspace) {
      const files = listTree(workspace, { query: q, max: 300 });
      chunks.push(files.map((f) => f.path).join('\n') || '(工作目录为空)');
    }
    for (const root of extra) {
      if (!fs.existsSync(root)) continue;
      const files = listTree(root, { query: q, max: 80 });
      const lines = files.map((f) => path.join(root, f.path).replace(/\\/g, '/'));
      const insideWs = workspace && isInside(workspace, root);
      const tag = insideWs || /[\\/](skills|rules)$/i.test(root) ? '技能/规则' : '附加目录';
      chunks.push(`[${tag}] ${root.replace(/\\/g, '/')}\n${lines.join('\n') || '(空)'}`);
    }
    return chunks.join('\n\n') || '(空目录)';
  }
  if (name === 'read_file') {
    const abs = resolveRead(workspace, extra, args.path);
    onEvent({ type: 'tool', name, status: 'running', detail: abs, text: `读取文件 ${abs}` });
    const ext = path.extname(abs).toLowerCase();
    if (isImageExt(ext)) {
      const text = await describeImageFile(abs, { signal, onEvent, lang });
      onEvent({ type: 'tool', name, status: 'done', detail: abs });
      return `【文件】${abs}\n${text}`;
    }
    if (isDocumentExt(ext)) {
      const parsed = await parseAttachment(abs, { signal });
      const note = parsed.images?.length
        ? `\n\n[文档内含 ${parsed.images.length} 张图。若已挂看图模型，请让用户把图作为附件发送，或把图片文件单独 read_file。]`
        : '';
      return `【文件】${abs}\n${parsed.text || ''}${note}`;
    }
    const sl = Number(args.startLine) || 0;
    const el = Number(args.endLine) || 0;
    if (sl > 0 || el > 0) {
      // 按行从完整文件读取，行首带行号，不截断
      const span = readLineRange(abs, sl, el);
      if (span.start > span.total || (el > 0 && sl > el) || span.start > span.end) {
        return `【文件】${abs}\n[行范围无效：文件共 ${span.total} 行]`;
      }
      const body = span.lines.map((ln, i) => `${span.start + i}: ${ln}`).join('\n');
      return `【文件】${abs} 第 ${span.start}-${span.end} 行 / 共 ${span.total} 行\n` + body;
    }
    const loaded = readTextFile(abs);
    if (loaded.binary) return `【文件】${abs}\n二进制文件，没有文本正文`;
    const totalLines = loaded.text ? loaded.text.split(/\r?\n/).length : 0;
    return `【文件】${abs} 全文 / 共 ${totalLines} 行\n` + loaded.text;
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
    // 增量更新项目地图：只重抽这一个文件的符号与依赖，行号立刻跟上，不重建整图
    try { codeIndex.upsertFile(workspace, abs, extra); } catch (err) { diag.log('map', '写文件后更新地图失败', { path: abs, message: err && err.message }); }
    return `已写入 ${abs}`;
  }
  if (name === 'create_dir') {
    const rel = String(args.path || args.dir || '').replace(/\\/g, '/').trim();
    if (!rel) throw new Error('路径为空');
    const abs = resolveAllowed(workspace, extra, rel);
    diag.log('tool', '开始创建目录', { path: abs });
    try {
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) throw new Error('路径已存在且不是文件夹：' + abs);
        onEvent({ type: 'tool', name, status: 'done', detail: abs });
        onEvent({ type: 'files', changes: [{ path: rel, action: 'mkdir' }] });
        return `目录已存在 ${abs}`;
      }
      fs.mkdirSync(abs, { recursive: true });
    } catch (err) {
      diag.log('tool', '创建目录失败', { path: abs, message: err && err.message });
      throw err;
    }
    diag.log('tool', '创建目录完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    onEvent({ type: 'files', changes: [{ path: rel, action: 'mkdir' }] });
    return `已创建目录 ${abs}`;
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
    try { codeIndex.removeFile(workspace, abs, extra); } catch (err) { diag.log('map', '删文件后更新地图失败', { path: abs, message: err && err.message }); }
    return `已删除 ${abs}`;
  }
  if (name === 'search_text') {
    const target = String(args.path || '').trim();
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return searchText(dir, args.query || '', args.glob || '', signal);
    }
    const parts = [];
    if (workspace) parts.push(await searchText(workspace, args.query || '', args.glob || '', signal));
    for (const root of extra) {
      if (!root || !fs.existsSync(root)) continue;
      if (workspace && isInside(workspace, root)) continue;
      if (/[\\/](skills|rules)$/i.test(root)) continue;
      const block = await searchText(root, args.query || '', args.glob || '', signal);
      if (block && block !== '无匹配') parts.push(`[${root.replace(/\\/g, '/')}]\n${block}`);
    }
    const merged = parts.filter((p) => p && p !== '无匹配').join('\n\n');
    return merged || '无匹配';
  }
  if (name === 'semantic_search') {
    const q = String(args.query || '').trim();
    if (!q) return '查询为空';
    const target = String(args.path || '').trim();
    let within = '';
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      within = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    }
    onEvent({ type: 'tool', name, status: 'running', detail: q, text: `语义检索 ${q}` });
    return codeEmbed.search(workspace, extra, { query: q, within, limit: args.limit, signal });
  }
  if (name === 'goto_definition') {
    const symbol = String(args.symbol || args.name || args.query || '').trim();
    onEvent({ type: 'tool', name, status: 'running', detail: symbol, text: `跳转到定义 ${symbol}` });
    return codeIndex.gotoDefinition(workspace, extra, symbol);
  }
  if (name === 'map_lookup') {
    const q = String(args.query || '').trim();
    const mod = String(args.module || '').trim();
    if (!q && !mod) return '查询为空';
    const target = String(args.path || '').trim();
    let within = '';
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      within = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    }
    onEvent({ type: 'tool', name, status: 'running', detail: mod || q, text: `查项目地图 ${mod || q}` });
    return codeIndex.search(workspace, extra, {
      query: q,
      module: mod,
      within,
      limit: args.limit,
      signal
    });
  }
  if (name === 'memory_list') {
    if (!workspace) return '请先打开项目';
    const items = memory.list(workspace);
    if (!items.length) return '（暂无项目记忆）';
    return items.map((e) => {
      const pin = e.pinned ? ' [钉住]' : '';
      const paths = (e.paths || []).length ? ` · ${(e.paths || []).join(', ')}` : '';
      return `${e.id}${pin} (${e.kind}) ${e.summary}${paths}`;
    }).join('\n');
  }
  if (name === 'memory_add') {
    if (!workspace) throw new Error('请先打开项目');
    const added = memory.addUserMemory(workspace, {
      summary: args.summary,
      paths: args.paths,
      tags: args.tags,
      pinned: args.pinned !== false
    });
    onEvent({ type: 'tool', name, status: 'done', detail: 'memory' });
    return `已写入记忆 ${added.map((e) => e.id).join(', ')}`;
  }
  if (name === 'memory_forget') {
    if (!workspace) throw new Error('请先打开项目');
    memory.remove(workspace, args.id);
    onEvent({ type: 'tool', name, status: 'done', detail: args.id });
    return `已删除记忆 ${args.id}`;
  }
  if (name === 'working_memory_update') {
    const err = new Error('WORKING_MEMORY_UPDATE');
    err.code = 'working_memory_update';
    err.patch = {
      goal: args.goal,
      openQuestions: args.openQuestions,
      focusPaths: args.focusPaths,
      scratch: args.scratch,
      addScratch: args.addScratch,
      addQuestion: args.addQuestion
    };
    throw err;
  }
  if (name === 'ask_user') {
    const err = new Error('ASK_USER');
    err.code = 'ask_user';
    err.ask = {
      question: String(args.question || '').trim(),
      options: Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 8) : [],
      allowFreeText: args.allowFreeText !== false
    };
    if (!err.ask.question) throw new Error('ask_user 需要 question');
    throw err;
  }
  if (name === 'run_command') {
    const s = store.load();
    if (s.commandSandbox?.enabled === false) {
      return '命令沙盒已关闭，无法执行 shell。请在设置中开启「命令沙盒」。';
    }
    if (!workspace) throw new Error('请先打开项目');
    const command = String(args.command || '').trim();
    if (!command) throw new Error('command 不能为空');
    const timeoutMs = Math.max(3, Number(s.commandSandbox?.timeoutSec) || 60) * 1000;
    onEvent({ type: 'tool', name, status: 'running', detail: command.slice(0, 120), text: `沙盒命令 ${command.slice(0, 120)}` });
    diag.log('sandbox', '执行命令', { command: command.slice(0, 200), cwd: args.cwd || '.' });
    const beforeScan = snapshot.scanFingerprints(workspace);
    if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
    const pre = snapshot.preBackupWorkspace(workspace, snap.current);
    if (pre.truncated || beforeScan.truncated) {
      diag.log('sandbox', '命令快照扫描已截断', { backed: pre.backed, max: 8000 });
    }
    const result = await sandbox.runSandboxed({
      command,
      workspace,
      cwd: args.cwd || '.',
      timeoutMs,
      signal
    });
    const afterScan = snapshot.scanFingerprints(workspace);
    const cmdChanges = snapshot.recordCommandDiff(workspace, snap.current, beforeScan, afterScan);
    if (cmdChanges.length) {
      diag.log('sandbox', '命令改动已记入快照', { count: cmdChanges.length, paths: cmdChanges.slice(0, 12).map((c) => c.path) });
      onEvent({
        type: 'files',
        snapshotId: snap.current.id,
        changes: snap.current.manifest.changes
      });
    }
    diag.log('sandbox', '命令结束', {
      code: result.code,
      timedOut: result.timedOut,
      blocked: !!result.blocked,
      out: (result.stdout || '').length,
      err: (result.stderr || '').length,
      tracked: cmdChanges.length
    });
    return sandbox.formatResult(result);
  }
  if (name === 'screen_look' || name === 'clipboard_look' || name === 'mouse_move' || name === 'mouse_click' || name === 'mouse_drag' || name === 'mouse_scroll' || name === 'keyboard_type' || name === 'keyboard_key') {
    const desktopHand = require('./desktop-hand');
    if (name === 'screen_look') {
      onEvent({ type: 'tool', name, status: 'running', text: '全屏截图' });
      const shot = await desktopHand.captureScreen();
      if (!shot.ok) return shot.message;
      let seen = '';
      try {
        seen = await describeImageFile(shot.path, { signal, onEvent, lang });
        shot.path = desktopHand.nameSightFile(shot.path, seen);
      } catch (err) {
        seen = err && err.message ? err.message : '看图失败';
      }
      return `【视力】已保存 ${shot.path}\n画面 ${shot.width}×${shot.height}。图内坐标左上角是 0,0，对应屏幕 (${shot.originX}, ${shot.originY})。mouse_click / mouse_move / mouse_drag / mouse_scroll 使用图内坐标。画线画圆用 mouse_drag。\n${seen}`;
    }
    if (name === 'clipboard_look') {
      onEvent({ type: 'tool', name, status: 'running', text: '读取剪贴板图片' });
      const shot = desktopHand.importClipboardImage();
      if (!shot.ok) return shot.message;
      let seen = '';
      try {
        seen = await describeImageFile(shot.path, { signal, onEvent, lang });
        shot.path = desktopHand.nameSightFile(shot.path, seen);
      } catch (err) {
        seen = err && err.message ? err.message : '看图失败';
      }
      return `【视力】已从剪贴板保存 ${shot.path}\n${seen}`;
    }
    if (name === 'mouse_move') return desktopHand.moveTo(args.x, args.y);
    if (name === 'mouse_click') return desktopHand.clickAt(args.x, args.y, args.button, args.times || (args.double ? 2 : 1));
    if (name === 'mouse_drag') return desktopHand.dragStroke(args.points, args.button);
    if (name === 'mouse_scroll') return desktopHand.scrollAt(args.x, args.y, args.delta);
    if (name === 'keyboard_type') return desktopHand.typeText(args.text);
    return desktopHand.tapKeys(args.key || args.combo);
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
 * 生图/生视频/生3D/生文档：组合优先，否则全局能力默认 + fallback
 */
async function runGenerateSlots({ vs, userText, workspace, extra, extraTexts, onEvent, signal, snap, lang }) {
  const wanted = assembly.detectRoles(userText, { hasImages: false, contextChars: 0 })
    .filter((r) => assembly.GEN_ROLE_IDS.includes(r));
  for (const role of wanted) {
    const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
    const candidates = assembly.roleCandidates(vs, role);
    if (!candidates.length) {
      const tip = `检测到${roleName}需求，但未配置${roleName}模型（组合或全局能力默认）。`;
      onEvent({ type: 'think', text: tip });
      extraTexts.push(`【${roleName}未配置】${tip}请在「文件→模型组合」添加${roleName}槽位并挂上本地 GGUF 或接口模型。`);
      continue;
    }
    let done = false;
    let lastErr = null;
    const errors = [];
    for (const cand of candidates) {
      const helperCfg = assembly.slotToModelCfg(cand.slot, vs);
      if (!helperCfg) continue;
      const helperLabel = helperCfg.model || helperCfg.name || roleName;
      const srcHint = cand.source === 'assembly' ? '组合'
        : cand.source === 'local-auto' ? '本地自动'
          : (cand.source === 'fallback' ? '备用' : '全局');
      onEvent({
        type: 'status',
        text: `正在用${roleName}模型 ${helperLabel}（${srcHint}）生成…`,
        activeModel: helperLabel,
        activeRole: role
      });
      diag.log('agent', '路由到生成槽位', { role, model: helperLabel, source: cand.source });
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
            onWait: (sec) => onEvent({
              type: 'status',
              text: `${roleName}模型处理中 · ${sec}`,
              activeModel: helperLabel,
              activeRole: role
            })
          });
          const out = String(msg?.content || '').trim();
          if (!out) throw new Error('文档模型没有返回内容');
          const rel = writeGeneratedFile(workspace, extra, snap, `generated/doc-${fileStamp()}.md`, out, 'utf8');
          extraTexts.push(`—— 以下是${roleName}模型「${helperLabel}」已写入的文档 ——`);
          extraTexts.push(`文件：${rel}\n\n${out.slice(0, 8000)}`);
          onEvent({ type: 'think', text: `已生成文档 ${rel}` });
        } else {
          const asset = await generate.generateMedia({
            role,
            modelCfg: helperCfg,
            prompt: userText,
            signal,
            modelsDir: vs.modelsDir || store.defaultModelsDir(),
            onWait: (text) => onEvent({ type: 'status', text })
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
        }
        done = true;
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        errors.push(`[${srcHint}·${helperLabel}] ${e.message}`);
        onEvent({ type: 'think', text: `${roleName}（${srcHint}·${helperLabel}）失败：${e.message}` });
        diag.log('agent', '生成槽位失败，尝试下一候选', { role, source: cand.source, message: e && e.message });
      }
    }
    if (!done) {
      const detail = errors.length ? errors.join('；') : (lastErr?.message || '无可用模型');
      const localTried = errors.some((e) => /组合|本地自动/.test(e));
      let hint = '';
      if (role === 'imageGen' && localTried) {
        hint = '聊天模型与生图模型是分开的，这次没有使用聊天接口。上面的原文是本地生图引擎或配套文件（VAE / 文本编码器）下载或运行失败。请原样转述这段原文，不要把它说成聊天 API 的 401，也不要建议用户去改聊天模型的 key。';
      } else if (role === 'imageGen') {
        hint = '没有走本地生图。请在「文件→模型组合→生图」挂本地 GGUF，不要把聊天接口填进生图槽。';
      }
      extraTexts.push(`【${roleName}失败】${detail}${hint ? `。${hint}` : ''}`);
    }
  }
}

function buildSystemPrompt({
  workspace, rules, skill, extra, allSkills, persona, visionMode, visionBridge, lang,
  memoryEntries, globalPrefs, profile, workingMemory, contextSummary, zbaingBridge, brainHandsOff
}) {
  const langInfo = lang || replyLang.fromLocale(store.load().locale);
  const personaText = replyLang.softenForcedChinese(String(persona || '').trim());
  const enPrompt = replyLang.promptInEnglish(langInfo);
  const personaSection = personaText
    ? (enPrompt ? `\n\n## Persona (always follow)\n${personaText}\n` : `\n\n## 人设（必须始终遵守）\n${personaText}\n`)
    : '';
  const profileBlock = memoryGlobal.formatProfile(profile, { english: enPrompt });
  const prefsBlock = memoryGlobal.formatPrefs(globalPrefs, { english: enPrompt });
  const longBlock = memory.formatForPrompt(memoryEntries || [], { english: enPrompt });
  const workBlock = compact.formatWorking(workingMemory, { english: enPrompt });
  const summaryBlock = compact.formatSummaryForPrompt(contextSummary, { english: enPrompt });
  const memParts = [profileBlock, prefsBlock, longBlock, workBlock, summaryBlock].filter(Boolean);
  const memoryBlock = memParts.length ? `\n${memParts.join('\n\n')}\n` : '';
  const askHint = enPrompt
    ? `\nIf the request is ambiguous, would break confirmed conventions, or has multiple valid approaches, call ask_user and wait. Do not silently rewrite settled behavior.\n`
    : `\n若需求含糊、可能破坏已确认约定、或有多种实现，必须先调用 ask_user 等待用户回答，再改文件；禁止默默推翻已确认行为。\n`;
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
  const zbaingSection = zbaingBridge
    ? (enPrompt
      ? `\nzbaingAi runs locally without tool-call API. SpCode may inject workspace blocks (directory listings, file contents, search hits) in the user message. Answer from those blocks. Do not say you cannot read files or access the project.\n`
      : `\nzbaingAi 为本地引擎，不走工具调用接口。SpCode 会在用户消息里注入【工作区目录】【文件名】等块。你必须根据这些材料回答，禁止说自己无法读文件、无法访问项目或只能处理对话文字。\n`)
    : '';
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
  const handoff = brainHandsOff
    ? (enPrompt
      ? `\nYou are the brain. Read, search, and decide the design. File writes, deletes, new folders, and shell commands must go through call_worker with role "code". The task is the spec the implementer must follow. Include: file paths, method names and the line numbers you already read, current behavior, the exact target behavior step by step, and what must stay unchanged. A one-line request is rejected. Do not call write_file, delete_file, create_dir, or run_command yourself. After the worker returns, check that the result matches your design.\n`
      : `\n你是大脑。查资料和定方案由你完成。改文件、删文件、建目录、执行命令必须调用 call_worker，role 填 code。task 就是实现模型必须照做的设计，写全这些内容：要改的文件路径、相关方法名和你读到的行号、现在的行为、要改成的行为（逐步写清）、明确不要改的范围。禁止只写「修一下」这种一句话，这种任务会被退回、不会执行。禁止自己调用 write_file、delete_file、create_dir、run_command。实现模型返回后，用它的短说明向用户交代即可。同一处修改只委托一次，不要再把同一批文件读一遍。\n`)
    : '';
  const genNote = enPrompt
    ? `\nWhen the user asks to generate images/videos/3D/docs, SimpleCode runs that automatically BEFORE you reply (no tool call needed). Check the user message for blocks like "生图已完成" or 【生图失败】/【生图未配置】 and answer from those results. Do not say you lack an image-generation tool. A local image model is stored by filename and resolved inside the models folder; do not ask the user to paste an absolute path. A 401 inside 【生图失败】 is a HuggingFace/engine download failure for companion files, not the chat API and not a missing file path. Repeat the failure text as-is. Do not search the workspace for Bearer tokens.\n`
    : `\n用户要求生图/生视频/生3D/生文档时，SimpleCode 会在你回复前自动执行（无需你调用工具）。请看用户消息里是否已有「生图已完成」或【生图失败】/【生图未配置】等段落并据此回答，禁止说自己没有生图工具。生图槽里写文件名即可，程序会在模型目录里找到文件，禁止要求用户改成绝对路径。【生图失败】里的 401 是下载生图引擎或配套文件时 HuggingFace/GitHub 拒绝访问，不是聊天接口，也不是模型路径填错。请原样转述失败原文，禁止去项目里搜 Bearer。\n`;
  if (enPrompt) {
    return `${langLine}${personaSection}${zbaingSection}${visionSection}${genNote}${memoryBlock}${askHint}
Workspace: ${workspace || '(none)'}
You may read any absolute path on this machine (not limited to the workspace), like Cursor. list_dir / read_file / search_text / map_lookup / semantic_search accept absolute paths.
Relevant modules may already appear under "项目地图" in the user message. Use goto_definition for a known symbol name, semantic_search when you only know the intent, map_lookup for the module method list, and search_text for an exact string. After write_file, a 【类型检查】 block is real compiler output for that file; fix those errors before finishing.
You may write/delete files and create folders (create_dir) in the workspace, user-added extra folders, and skill/rule folders.
Skill folders:
${appSkills.map((p) => `- ${p}`).join('\n') || '- (none)'}
Installed skills (when asked about a skill, read_file the SKILL.md; do not rely on memory):
${catalog || '- (none)'}
Writes and deletes in the workspace are snapshotted and can be restored. run_command also tracks file changes made by scripts (pre-backup before run, diff after) so they appear in the changed-files list and can be restored.
Use memory_add for durable project conventions; working_memory_update for this-chat notes; ask_user to clarify.
Shell via run_command runs in a sandbox (cwd inside the project, dangerous commands blocked, timeout). Prefer write_file for source edits; use run_command for tests/build/git. Do not run encoding probes (no enc_*.txt); write_file is UTF-8. If the user message already contains 【全文】 for a file, use that text and do not read it again. For modules that already have descriptions and line numbers, read with startLine/endLine and do not re-read the whole file. When the user has turned on the desktop hand, use screen_look before clicking, clipboard_look for a pasted image, then mouse_move, mouse_click, mouse_drag, mouse_scroll, keyboard_type, and keyboard_key. Draw strokes and circles with mouse_drag (press, move along points, release). If that switch is off, do not pretend you can see or click the screen.
Independent read_file / list_dir / search_text / map_lookup / memory_list in the same round should be emitted together as multiple tool calls; writes, deletes, create_dir, run_command, memory writes and ask_user stay serial after their inputs are known.
Say in one or two sentences what you will do, then call tools.
Do not invent unread file contents. After edits, list the files you changed.
Source files must be UTF-8. Never produce mojibake.

## Rules
${ruleText || 'None'}
${skillText}${handoff}`;
  }
  return `${langLine}${personaSection}${zbaingSection}${visionSection}${genNote}${memoryBlock}${askHint}
当前工作目录：${workspace || '（未选择）'}
你可以像 Cursor 一样读取本机任意绝对路径（不限于当前工作目录）。list_dir / read_file / search_text / map_lookup / semantic_search 都支持绝对路径。
已知符号名用 goto_definition 跳到定义。只知道意图、不知道名字时用 semantic_search。模块方法列表用 map_lookup。精确字符串用 search_text。write_file 返回里的【类型检查】是该文件的编译错误，改到通过再收尾。
写入、删除和新建文件夹只允许工作目录、用户添加的附加目录、以及技能/规则目录。新建空文件夹用 create_dir（可一次建多层）。
技能目录：
${appSkills.map((p) => `- ${p}`).join('\n') || '- （无）'}
已安装技能（用户问技能内容时，必须 read_file 读取对应 SKILL.md，不要凭记忆）：
${catalog || '- （还没有技能）'}
写入或删除工作目录文件会自动快照，用户可还原。run_command 执行的脚本若改动了工作区文件，也会记入快照和「已更改文件」，可一并还原。
项目长期约定用 memory_add；本会话要点用 working_memory_update；含糊时用 ask_user。
需要跑测试/构建/git 时用 run_command（命令沙盒：只能在项目目录内，拦截高危命令，有超时）；改源码优先 write_file，不要写 tmp_*.ps1 批量替换。不要先做编码探针（不要写 enc_*.txt 试编码），write_file 一律 UTF-8。用户消息里已经带了【全文】的文件，直接用这段正文，不要再读一遍。已经有作用和行号的模块，用 startLine/endLine 只读片段，不要整文件重读。用户打开「活过来」后，可以用 screen_look 看屏幕、clipboard_look 看剪贴板图片，再用 mouse_move / mouse_click / mouse_drag / mouse_scroll / keyboard_type / keyboard_key 操作。画线、画圆必须用 mouse_drag：按住并沿 points 拖动后松开，不要拆成多次点击。先看屏幕再点。开关没开时不要假装能看见或能点击。
同一轮里互不依赖的 read_file / list_dir / search_text / map_lookup / memory_list 请一次发出多条 tool call，不要拆成多轮；写入、删除、建目录、命令、记忆写入和 ask_user 必须等结果后再做。
先用一两句说明你准备怎么做，再调用工具。
不要编造未读过的文件内容。改完后用短列表说明改了哪些文件。
代码与注释编码必须是 UTF-8，禁止乱码。

## 规则
${ruleText || '无额外规则'}
${skillText}${handoff}`;
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

async function callVisionEndpoint({ endpoint, model, dataUrl, signal, onWait, lang, apiKey, protocol }) {
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
    const res = await httpFetch(url, { // 走系统代理，与聊天主链路一致
      method: 'POST',
      headers: (() => {
        const h = { 'Content-Type': 'application/json' };
        // 看图端点（API 模型的视觉能力）需要鉴权：openai 系带 Bearer，anthropic/gemini 用各自的 key 头
        if (apiKey) {
          const p = String(protocol || 'openai').toLowerCase();
          if (p === 'anthropic') h['x-api-key'] = apiKey;
          else if (p === 'gemini') h['x-goog-api-key'] = apiKey;
          else h['Authorization'] = 'Bearer ' + apiKey;
        }
        return h;
      })(),
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
async function visionRecognize({ model, mmproj: mmprojPath, endpoint, dataUrl, signal, onWait, lang, apiKey, protocol }) {
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
      const text = await callVisionEndpoint({ endpoint: ep, model, dataUrl, signal, onWait: say, lang, apiKey, protocol });
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
    lang: lang || replyLang.fromLocale(store.load().locale),
    apiKey: vis.apiKey,
    protocol: vis.protocol
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

function zbaingWantsExplore(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /(读|看|浏览|列出|扫描|了解|分析|打开).{0,16}(项目|工程|工作区|目录|文件夹|代码库|workspace|repo|当前)/i.test(t)
    || /(项目|工程|工作区|目录|代码库).{0,16}(读|看|浏览|列出|扫描|结构|情况)/i.test(t)
    || /读取.{0,12}当前/i.test(t)
    || /当前目录/i.test(t);
}

function zbaingSearchQuery(text) {
  const t = String(text || '').trim();
  const m = t.match(/(?:搜索|查找|search|find)\s+[`'"]?(.+?)[`'"]?\s*$/i);
  return m ? m[1].trim() : '';
}

async function zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang }) {
  if (!workspace) return '';
  const blocks = [];
  const toolLabel = { list_dir: '查看目录', read_file: '读取文件', search_text: '搜索代码' };

  if (zbaingWantsExplore(userText)) {
    onEvent({ type: 'tool', name: 'list_dir', status: 'running', detail: workspace, text: toolLabel.list_dir });
    const tree = await execTool(workspace, snap, 'list_dir', {}, onEvent, extra, signal, lang);
    onEvent({ type: 'tool', name: 'list_dir', status: 'done', detail: workspace, text: `完成：${toolLabel.list_dir}` });
    blocks.push(`【工作区目录】\n${tree}`);
    for (const f of ['README.md', 'readme.md', 'AGENTS.md', 'package.json', 'config.json']) {
      const abs = path.join(workspace, f);
      if (!fs.existsSync(abs)) continue;
      try {
        onEvent({ type: 'tool', name: 'read_file', status: 'running', detail: f, text: `${toolLabel.read_file} ${f}` });
        const content = await execTool(workspace, snap, 'read_file', { path: f }, onEvent, extra, signal, lang);
        onEvent({ type: 'tool', name: 'read_file', status: 'done', detail: f, text: `完成：${toolLabel.read_file} ${f}` });
        blocks.push(`【${f}】\n${String(content)}`);
      } catch { /* skip unreadable */ }
    }
  }

  const q = zbaingSearchQuery(userText);
  if (q) {
    onEvent({ type: 'tool', name: 'search_text', status: 'running', detail: q, text: `${toolLabel.search_text} ${q}` });
    const hits = await execTool(workspace, snap, 'search_text', { query: q }, onEvent, extra, signal, lang);
    onEvent({ type: 'tool', name: 'search_text', status: 'done', detail: q, text: `完成：${toolLabel.search_text}` });
    blocks.push(`【搜索结果：${q}】\n${hits}`);
  }

  return blocks.length ? blocks.join('\n\n') : '';
}

function sameModel(a, b) {
  if (!a || !b) return false;
  if (isLocalGguf(a) && isLocalGguf(b)) {
    return (a.model || a.modelPath) === (b.model || b.modelPath);
  }
  return !!(a.id && a.id === b.id);
}

function buildRoster(vs, modelCfg) {
  const brainName = modelCfg.model || modelCfg.name || '主模型';
  const models = [{ name: brainName, role: 'brain' }];
  for (const role of assembly.ROLES) {
    const hit = assembly.resolveRole(vs, role.id);
    if (!hit) continue;
    const cfg = assembly.slotToModelCfg(hit.slot, vs);
    if (!cfg || sameModel(cfg, modelCfg)) continue;
    const name = cfg.model || cfg.name || role.name;
    if (models.some((m) => m.name === name && m.role === role.id)) continue;
    models.push({ name, role: role.id });
  }
  return models;
}

function codeWorkerOf(vs, modelCfg) {
  const hit = assembly.resolveRole(vs, 'code');
  if (!hit) return null;
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  if (!cfg || sameModel(cfg, modelCfg)) return null;
  return cfg;
}

function roleDisplayName(vs, roleId, modelCfg) {
  const hit = assembly.resolveRole(vs, roleId);
  if (!hit) return '';
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  if (!cfg || sameModel(cfg, modelCfg)) return '';
  return cfg.model || cfg.name || '';
}

function workerTaskReady(task) {
  const t = String(task || '').trim();
  if (t.length < 120) return false;
  return /[\\/]|\.[a-z0-9]{1,8}\b/i.test(t);
}

function isLocalGguf(modelCfg) {
  if (!modelCfg) return false;
  if (modelCfg.type === 'local') return true;
  if (modelCfg.modelPath) return true;
  return /\.gguf$/i.test(String(modelCfg.model || ''));
}

function isZbaingAi(modelCfg) {
  return modelCfg?.type === 'zbaingAi' || modelCfg?.id === 'zbaingAi';
}

function isZbaingModule(modelCfg) {
  return modelCfg?.type === 'zbaingModule' && !!modelCfg?.moduleId;
}

function isEmptyZbaingReply(msg) {
  const t = asText(msg?.content).trim();
  if (!t) return true;
  return /zbaingAi 没有返回内容|没有生成到文字/.test(t);
}

function pickTextFallbackCfg(exceptId) {
  const s = store.load();
  const usable = [];
  for (const m of s.models || []) {
    if (!m || m.id === exceptId) continue;
    if (m.type === 'zbaingAi' || m.type === 'zbaingModule' || m.id === 'zbaingAi') continue;
    const cfg = store.resolveModelCfg(m.id, s);
    if (!cfg) continue;
    if (cfg.type === 'local' && (cfg.modelPath || cfg.model)) usable.push(cfg);
    else if (cfg.baseUrl && cfg.model) usable.push(cfg);
  }
  return usable.find((c) => c.type !== 'local') || usable[0] || null;
}

async function completeOnce({ modelCfg, messages, workspace, stream, onDelta, onReason, onThink, signal, useTools = true, onWait, toolSpec }) {
  onDelta = onDelta || (() => {});
  onReason = onReason || (() => {});
  onThink = onThink || (() => {});
  onWait = onWait || (() => {});
  if (isZbaingModule(modelCfg)) {
    const zb = (store.load().models || []).find((m) => m.type === 'zbaingAi' || m.id === 'zbaingAi') || {};
    const msg = await zbaingAi.complete({
      modelCfg: { ...zb, zbaingRoot: modelCfg.zbaingRoot || zb.zbaingRoot },
      messages,
      workspace,
      onDelta,
      onThink,
      onReason,
      signal,
      module: modelCfg.moduleId,
      role: modelCfg._helperRole || ''
    });
    return toolXml.hydrateAssistantTools(msg);
  }
  if (isZbaingAi(modelCfg)) {
    const msg = await zbaingAi.complete({ modelCfg, messages, workspace, onDelta, onThink, onReason, signal });
    return toolXml.hydrateAssistantTools(msg);
  }
  if (isLocalGguf(modelCfg)) {
    return localLlm.complete({
      modelCfg,
      modelsDir: store.load().modelsDir || store.defaultModelsDir(),
      messages,
      onDelta,
      onReason,
      signal,
      onWait,
      tools: useTools ? (toolSpec || toolsSpec()) : null
    }).then((msg) => toolXml.hydrateAssistantTools(msg));
  }
  return apiProtocol.complete({
    modelCfg: {
      ...modelCfg,
      protocol: apiProtocol.normalizeProtocol(modelCfg.protocol)
    },
    messages,
    stream: !!stream,
    tools: useTools ? (toolSpec || toolsSpec()) : null,
    onDelta,
    onReason,
    signal,
    onWait
  }).then((msg) => toolXml.hydrateAssistantTools(msg));
}

function hasOutput(msg) {
  const named = (msg?.tool_calls || []).some((t) => t?.function?.name);
  return !!(asText(msg?.content).trim() || named);
}

function isUserStop(e, signal) {
  if (signal?.aborted) return true;
  return e?.name === 'AbortError' && (e?.code === 'aborted' || /已停止/.test(String(e?.message || '')));
}

function isRetryableHttpError(e) {
  if (!e || isUserStop(e)) return false;
  if (e.code === 'timeout') return false;
  const status = Number(e.status || e.statusCode || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(e.message || e.body || e || '');
  return /429|429001|rate exceeds|RPM limit|too many requests|ECONNRESET|socket hang up|fetch failed|network|overloaded|temporar|high demand|503|502|504/i.test(msg);
}

function retryDelayMs(e, attempt) {
  const raw = Number(e?.retryAfter);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(60000, raw < 200 ? raw * 1000 : raw);
  }
  return Math.min(20000, 2000 * (2 ** attempt));
}

function abortErr() {
  return Object.assign(new Error('已停止'), { name: 'AbortError', code: 'aborted' });
}

function sleepMs(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortErr());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErr());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitStatus(onEvent) {
  return (sec) => {
    const text = typeof sec === 'string' ? sec : `正在等待模型响应 · ${sec}`;
    onEvent({ type: 'status', text });
  };
}

function formatToolProgress(messages) {
  const bits = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const names = m.tool_calls.map((t) => t.function?.name).filter(Boolean).join(', ');
      if (names) bits.push(`已调用：${names}`);
    }
    if (m.role === 'tool') {
      const body = asText(m.content);
      const keep = body.includes('【文件】') || body.includes('【全文】');
      bits.push(`【工具结果】\n${keep ? body : body.slice(0, 12000)}`);
    }
  }
  return bits.join('\n\n');
}

async function completeOnceWithRetry(opts, mode) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const msg = await completeOnce({ ...opts, ...mode });
      if (hasOutput(msg)) return msg;
      if (isZbaingAi(opts.modelCfg) || isZbaingModule(opts.modelCfg)) {
        return { ...(msg || {}), role: 'assistant', content: asText(msg?.content) };
      }
      lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
      break;
    } catch (e) {
      if (isUserStop(e, opts.signal)) throw e;
      lastErr = e;
      if (e.code === 'no_vision') throw e;
      if (!isRetryableHttpError(e) || i >= 3) break;
      const wait = retryDelayMs(e, i);
      const sec = Math.max(1, Math.ceil(wait / 1000));
      opts.onWait?.(`接口繁忙或限流，${sec} 秒后重试（${i + 1}/4）…`);
      diag.log('agent', '请求可重试失败，等待后重试', {
        status: e.status,
        wait,
        attempt: i + 1,
        message: e && e.message
      });
      await sleepMs(wait, opts.signal);
    }
  }
  throw lastErr || new Error('模型没有返回内容');
}

async function completeWithFallback(opts) {
  const noTools = !!opts.noTools;
  if (isZbaingAi(opts.modelCfg) || isZbaingModule(opts.modelCfg)) {
    return completeOnceWithRetry(opts, { stream: true, useTools: false });
  }
  if (isLocalGguf(opts.modelCfg)) {
    let lastErr;
    for (const useTools of (noTools ? [false] : [true, false])) {
      try {
        const msg = await completeOnceWithRetry(opts, { stream: true, useTools });
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
      const msg = await completeOnceWithRetry(opts, mode);
      if (hasOutput(msg)) return msg;
      lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
    } catch (e) {
      if (isUserStop(e, opts.signal)) throw e;
      lastErr = e;
      if (e.code === 'no_vision' && Array.isArray(opts.messages?.[opts.messages.length - 1]?.content)) {
        diag.log('agent', '接口不接受图片，改为纯文字重试', { model: opts.modelCfg?.model });
        opts = { ...opts, messages: flattenMessages(opts.messages) };
        continue;
      }
      if (isRetryableHttpError(e)) break;
    }
  }
  throw lastErr || new Error('模型没有返回内容');
}

async function agentLoop({ modelCfg, messages, workspace, extra, snap, onEvent, signal, lang, workingMemoryRef, waitForUserAnswer, maxRounds, toolSpec, workers, roleTag, depth, hardRounds, planningName, unlimitedRounds }) {
  const thinkLimit = store.clampAgentRounds(maxRounds != null ? maxRounds : DEFAULT_MAX_ROUNDS);
  const toolLabel = {
    list_dir: '查看目录',
    read_file: '读取文件',
    write_file: '写入文件',
    create_dir: '创建文件夹',
    mkdir: '创建文件夹',
    delete_file: '删除文件',
    search_text: '搜索代码',
    semantic_search: '语义检索',
    map_lookup: '查项目地图',
    goto_definition: '跳转到定义',
    memory_list: '查看记忆',
    memory_add: '写入记忆',
    memory_forget: '删除记忆',
    working_memory_update: '更新工作记忆',
    ask_user: '询问用户',
    screen_look: '看屏幕',
    clipboard_look: '看剪贴板',
    mouse_move: '移动虚拟光标',
    mouse_click: '点击',
    mouse_drag: '长按拖动',
    mouse_scroll: '滚动',
    keyboard_type: '输入文字',
    keyboard_key: '按键',
    run_command: '沙盒命令',
    call_worker: '交给实现模型'
  };
  let finalText = '';
  let answered = false;
  let softRetry = 0;
  let errorResume = 0;
  const isZbaing = isZbaingAi(modelCfg) || isZbaingModule(modelCfg);
  const seenToolKeys = new Map();
  let thinkUsed = 0;
  let planningUsed = 0;
  let brainUsed = 0;
  let implementing = false;
  let handedOff = false;
  let lastPhase = roleTag === 'code' ? 'code' : 'brain';
  // 全解放：不吃用户轮数，也不吃安全上限，直到模型收尾或用户停止
  const unlimited = !!unlimitedRounds && !(hardRounds > 0);
  const roundCap = hardRounds > 0 ? hardRounds : (unlimited ? Number.POSITIVE_INFINITY : SAFETY_MAX_ROUNDS);
  for (let round = 0; round < roundCap; round++) {
    if (signal?.aborted) throw new Error('已停止');
    const brainName = modelCfg.model || modelCfg.name || '主模型';
    const tag = roleTag || 'brain';
    // 交给实现模型之前是规划阶段，高亮规划槽，不要标成大脑
    const planningNow = tag === 'brain' && !handedOff && !implementing && !!planningName;
    // 规划、大脑、代码各记各的轮数，互不扣减
    const countAs = planningNow ? 'planning' : (tag === 'code' ? 'code' : 'brain');
    lastPhase = countAs;
    const usedNow = countAs === 'planning' ? planningUsed : (countAs === 'code' ? thinkUsed : brainUsed);
    if (!unlimited && !(hardRounds > 0) && !compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing })) break;
    if (!isZbaing) {
      onEvent({
        type: 'think',
        text: planningNow
          ? '正在规划...'
          : (round === 0 ? '正在思考...' : (implementing ? '继续改代码...' : '根据工具结果继续思考...'))
      });
    }
    onEvent({
      type: 'status',
      text: planningNow
        ? `正在规划 · ${planningName}（${unlimited ? '全解放' : `${planningUsed + 1}/${thinkLimit}`}）`
        : (tag === 'brain'
          ? ((implementing || handedOff)
            ? (implementing
              ? `正在调用 ${brainName}（大脑 · 验收）…`
              : `正在调用 ${brainName}（大脑 · 验收 ${unlimited ? '全解放' : `${brainUsed + 1}/${thinkLimit}`}）…`)
            : `正在调用 ${brainName}（大脑 · 思考 ${unlimited ? '全解放' : `${brainUsed + 1}/${thinkLimit}`}）…`)
          : (implementing
            ? `正在调用 ${brainName}（代码 · 改代码）…`
            : `正在调用 ${brainName}（代码 · 实现 ${unlimited ? '全解放' : `${thinkUsed + 1}/${thinkLimit}`}）…`)),
      activeModel: planningNow ? planningName : brainName,
      activeRole: planningNow ? 'planning' : tag
    });
    diag.log('agent', '请求模型', {
      round,
      model: modelCfg.model,
      消息条数: messages.length,
      阶段: countAs,
      规划已用: planningUsed,
      大脑已用: brainUsed,
      代码已用: thinkUsed,
      思考上限: thinkLimit,
      实现中: implementing
    });
    let msg;
    try {
      msg = await completeWithFallback({
        modelCfg,
        messages,
        workspace,
        onDelta: (t) => onEvent({ type: 'reason', text: t }),
        onReason: (t) => onEvent({ type: 'reason', text: t }),
        onThink: (t) => onEvent({ type: 'think', text: t }),
        onWait: waitStatus(onEvent),
        signal,
        toolSpec: toolSpec || toolsSpec()
      });
    } catch (e) {
      if (isUserStop(e, signal)) throw e;
      if (compact.isContextOverflowError(e)) {
        e.code = e.code || 'context_overflow';
        throw e;
      }
      const hasProgress = (messages || []).some((m) => m.role === 'tool') || !!finalText;
      diag.log('agent', '本轮模型调用失败，尝试接上', {
        round,
        message: e && e.message,
        hasProgress
      });
      const canResume = (unlimited || round < SAFETY_MAX_ROUNDS - 1) && (unlimited || compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing }));
      if (hasProgress && canResume && errorResume < 2) {
        errorResume += 1;
        onEvent({ type: 'think', text: `调用出错，正在用已有结果继续：${e.message}` });
        onEvent({ type: 'status', text: '出错了，正在接上…' });
        messages.push({
          role: 'user',
          content: `模型请求失败：${String(e.message || e).slice(0, 500)}\n请根据已经拿到的工具结果继续完成用户任务，不要重复已经成功的步骤。若还需要读文件，直接发起 tool call。`
        });
        continue;
      }
      if (hasProgress) {
        const progress = formatToolProgress(messages);
        const note = `\n\n调用中断：${String(e.message || e).slice(0, 300)}\n已保留上面的工具结果。发送「继续」即可接上。`;
        finalText = [finalText, progress, note].filter(Boolean).join('\n');
        onEvent({ type: 'text', text: note });
        answered = true;
        break;
      }
      throw e;
    }
    diag.log('agent', '模型已返回', { round, 工具调用数: (msg.tool_calls || []).length });
    if (msg.zbaingMeta) {
      onEvent({
        type: 'zbaing_meta',
        source: msg.zbaingMeta.source,
        prompt: msg.zbaingMeta.prompt,
        minConf: msg.zbaingMeta.minConf,
        thinking: msg.zbaingMeta.thinking || ''
      });
    }
    messages.push(msg);
    if (!msg.tool_calls?.length) toolXml.hydrateAssistantTools(msg);
    const calls = (msg.tool_calls || []).filter((t) => t?.function?.name);
    if (calls.length) {
      // 过程稿不要占气泡：后面往往还要跑很多轮，占着会让人以为已经说完、其实还在调模型
      onEvent({ type: 'rewrite_text', text: '' });
      const draft = asText(msg.content).trim();
      if (draft) onEvent({ type: 'reason', text: draft.slice(0, 1500) });
      if (draft.length > 600) msg.content = draft.slice(0, 600) + '…';
    } else if (asText(msg.content)) {
      finalText = asText(msg.content);
      onEvent({ type: 'rewrite_text', text: finalText });
    }

    if (!calls.length) {
      const raw = `${asText(msg.content)}\n${asText(msg.reasoning_content)}`;
      const unfinished = !!(msg.truncated || toolXml.looksLikeXmlTool(raw) || toolXml.looksLikeUnfinishedToolTurn(raw));
      if (unfinished && softRetry < 2 && (unlimited || round < SAFETY_MAX_ROUNDS - 1) && (unlimited || compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing }))) {
        softRetry += 1;
        diag.log('agent', '回复未完成或工具调用未发出，继续本轮', {
          truncated: !!msg.truncated,
          preview: raw.slice(0, 400)
        });
        onEvent({ type: 'rewrite_text', text: toolXml.stripXmlTools(asText(msg.content)) });
        onEvent({ type: 'status', text: msg.truncated ? '输出被截断，正在继续…' : '工具调用未发出，正在重试…' });
        messages.push({
          role: 'user',
          content: msg.truncated
            ? '上一段输出被截断了。请从断开处继续；如果要读文件或列目录，请直接发起 function/tool call，不要把调用写成正文。'
            : '你提到了要调用工具，但没有发出有效的 tool call，系统没有执行。请立刻用接口提供的 function/tool call 调用 list_dir / read_file / search_text / map_lookup 等，不要把 XML 或 JSON 写进回复正文。'
        });
        continue;
      }
      answered = true;
      break;
    }

    const runOneTool = async (tc) => {
      const name = tc.function?.name || '';
      let args = {};
      try {
        args = toolXml.repairJsonArgs(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const detail = args.path || args.query || args.question || args.command || (args.task ? String(args.task).slice(0, 80) : '');
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
        if (name === 'call_worker') {
          const role = String(args.role || 'code');
          const task = String(args.task || '').trim();
          const worker = workers && workers[role];
          if ((depth || 0) > 0 || !worker) {
            result = '当前没有可调用的实现模型。';
          } else if (!task || !workerTaskReady(task)) {
            result = '任务不够具体，没有交给实现模型。请重新调用 call_worker，task 里写全：1. 要改的文件路径 2. 相关方法名和你读到的行号 3. 现在的行为 4. 要改成的行为（逐步，和你的设计一致） 5. 明确不要改的范围。不要只写一句话。';
          } else {
            const wName = worker.model || worker.name || role;
            handedOff = true;
            onEvent({
              type: 'status',
              text: `正在调用 ${wName}（代码 · 实现）…`,
              activeModel: wName,
              activeRole: role
            });
            const workerOnEvent = (ev) => {
              if (!ev) return;
              if (ev.type === 'rewrite_text' || ev.type === 'text') {
                if (ev.text) onEvent({ type: 'reason', text: String(ev.text).slice(0, 1500) });
                return;
              }
              onEvent(ev);
            };
            const out = await agentLoop({
              modelCfg: worker,
              messages: [
                { role: 'system', content: '你是实现模型。按大脑写好的设计改文件。只用 read_file 的 startLine/endLine 读设计点名的那一段，不要整文件重读，不要搜索别的模块。改完用几句话说明改了哪些文件。不要复述设计全文。' },
                { role: 'user', content: task }
              ],
              workspace,
              extra,
              snap,
              onEvent: workerOnEvent,
              signal,
              lang,
              workingMemoryRef,
              waitForUserAnswer,
              maxRounds: thinkLimit,
              unlimitedRounds: unlimited,
              toolSpec: toolsFor('worker'),
              workers: null,
              roleTag: 'code',
              depth: (depth || 0) + 1
            });
            result = String(out || '').trim().slice(0, 2000) || '实现模型没有返回说明。';
            onEvent({
              type: 'status',
              text: `正在调用 ${modelCfg.model || modelCfg.name || '主模型'}（大脑 · 验收）…`,
              activeModel: modelCfg.model || modelCfg.name || '主模型',
              activeRole: 'brain'
            });
          }
        } else if (workers && HAND_OFF_TOOLS.has(name) && !(depth || 0)) {
          result = '大脑不能直接改文件。请改用 call_worker，role 填 code。task 要写全路径、方法与行号、现状、目标行为、不要改的范围。';
        } else {
          result = await execTool(workspace, snap, name, args, onEvent, extra, signal, lang);
        }
        diag.log('agent', '工具执行完成', { name, 耗时毫秒: Date.now() - startedAt, 结果字符数: String(result || '').length });
      } catch (e) {
        if (e.code === 'working_memory_update' && workingMemoryRef) {
          workingMemoryRef.current = compact.patchWorking(workingMemoryRef.current, e.patch || {});
          result = `已更新工作记忆：${JSON.stringify(workingMemoryRef.current)}`;
          onEvent({ type: 'working_memory', workingMemory: workingMemoryRef.current });
        } else if (e.code === 'ask_user') {
          onEvent({
            type: 'ask',
            question: e.ask.question,
            options: e.ask.options || [],
            allowFreeText: e.ask.allowFreeText !== false,
            toolCallId: tc.id
          });
          onEvent({ type: 'status', text: '等待你的回答…' });
          if (typeof waitForUserAnswer !== 'function') {
            result = '询问机制未接通，请在下一条消息里直接回答。';
          } else {
            const answer = await waitForUserAnswer(e.ask, signal);
            result = `用户回答：${answer}`;
          }
        } else {
          result = `工具失败：${e.message}`;
          diag.log('agent', '工具执行失败', { name, 耗时毫秒: Date.now() - startedAt, message: e && e.message });
        }
      }
      onEvent({
        type: 'tool',
        name,
        status: 'done',
        detail,
        text: `完成：${toolLabel[name] || name}${detail ? ` ${detail}` : ''}`
      });
      return { tc, name, args, result };
    };

    const waves = compact.splitToolWaves(calls);
    for (const wave of waves) {
      const runParallel = wave.parallel && wave.calls.length > 1;
      if (runParallel) {
        diag.log('agent', '并行执行只读工具', { round, 数量: wave.calls.length });
      }
      const outs = runParallel
        ? await Promise.all(wave.calls.map(runOneTool))
        : await (async () => {
          const list = [];
          for (const tc of wave.calls) list.push(await runOneTool(tc));
          return list;
        })();
      for (const o of outs) {
        messages.push({
          role: 'tool',
          tool_call_id: o.tc.id,
          content: compact.clipToolResult(o.name, o.args, o.result, seenToolKeys)
        });
      }
      if (!workers && workspace && outs.some((o) => o.name === 'write_file')) {
        const written = outs.filter((o) => o.name === 'write_file').pop();
        const rel = written?.args?.path;
        if (rel) {
          try {
            const abs = path.resolve(workspace, String(rel));
            const types = await typecheck.checkFile(workspace, abs);
            const last = messages[messages.length - 1];
            if (types && last?.role === 'tool') last.content += `\n\n【类型检查】\n${types.slice(0, 1500)}`;
          } catch { /* 类型检查失败不挡住这次写入 */ }
        }
      }
    }
    compact.shrinkOlderToolMessages(messages, 2);
    if (compact.callsIncludeImplement(calls)) implementing = true;
    else if (countAs === 'planning') planningUsed += 1;
    else if (countAs === 'code') thinkUsed += 1;
    else brainUsed += 1;
  }

  if (!answered && !signal?.aborted) {
    onEvent({ type: 'status', text: '正在整理最终回答…' });
    const wrapHint = implementing
      ? '实现轮次已达安全上限。请根据已经改过的内容写出完整的最终回答，不要再调用任何工具。'
      : (lastPhase === 'planning'
        ? '规划轮次已用完。请根据已经拿到的信息直接写出完整的最终回答，不要再调用任何工具。'
        : (lastPhase === 'code'
          ? '代码轮次已用完。请根据已经改过的内容写出完整的最终回答，不要再调用任何工具。'
          : '大脑轮次已用完。请根据已经拿到的信息直接写出完整的最终回答；若还要改代码请在下一轮用户消息里继续，不要再只做搜索。'));
    messages.push({
      role: 'user',
      content: wrapHint
    });
    try {
      const finalMsg = await completeWithFallback({
        modelCfg,
        messages,
        noTools: true,
        onDelta: (t) => onEvent({ type: 'text', text: t }),
        onReason: (t) => onEvent({ type: 'reason', text: t }),
        onWait: waitStatus(onEvent),
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
  signal,
  workingMemory,
  contextSummary,
  waitForUserAnswer,
  extraFolders,
  maxAgentRounds,
  unlimitedRounds
}) {
  if (!modelCfg) {
    throw new Error('请先选择模型');
  }
  if (isZbaingAi(modelCfg)) {
    // zbaingAi 走本地 Python 引擎，不需要 API 地址或 GGUF 文件
  } else if (isLocalGguf(modelCfg)) {
    const dir = store.load().modelsDir || store.defaultModelsDir();
    if (!localLlm.resolveGgufPath(modelCfg, dir)) {
      throw new Error('未找到本地 GGUF 模型。请把 .gguf 文件放到本地模型目录，并在输入框旁选择。');
    }
  } else if (!modelCfg.baseUrl || !modelCfg.model) {
    throw new Error('请先在设置中配置 API 模型');
  }

  const extra = extraRoots(appRoot, workspace, extraFolders);
  const persona = skillsLib.loadPersona(appRoot).body || '';
  const snap = { current: null };
  const vs = store.load();
  const codeWorker = codeWorkerOf(vs, modelCfg);
  const planningName = roleDisplayName(vs, 'planning', modelCfg);
  const loopWorkers = codeWorker ? { code: codeWorker } : null;
  const loopTools = codeWorker ? toolsFor('brain', ['code']) : undefined;
  const roundLimit = store.clampAgentRounds(maxAgentRounds != null ? maxAgentRounds : vs.maxAgentRounds);
  const vis = assembly.visionFrom(vs);
  const lang = replyLang.resolve({ locale: vs.locale, userText, history });
  // 挂了看图槽位就走辅助模型；不要因为接口「支持看图」开关把组装的模型跳过
  const useHelper = !!(vis.model);
  const vision = modelSupportsVision(modelCfg);
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
      const abs = resolveRead(workspace, extra, p);
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
        const loaded = readTextFile(abs);
        ctxChunks.push(loaded.binary ? `@${p}（二进制文件）` : `【文件】${p}\n${loaded.text}`);
      }
    } catch (e) {
      ctxChunks.push(`@${p} 读取失败：${e.message}`);
    }
  }

  // 项目地图召回：本地读已生成的地图打分，命中模块与方法行号直接进提示词（不调模型、不建向量）
  if (workspace && String(userText || '').trim()) {
    try {
      const block = codeIndex.buildPromptBlock(workspace, userText, extra);
      if (block) extraTexts.push(block);
    } catch (e) {
      diag.log('map', '地图注入失败，本轮跳过', { message: e && e.message });
    }
  }

  if (skippedImages.length && vis.model) {
    const label = vis.model;
    const list = skippedImages.slice(0, MAX_VISION_AGENT_IMAGES);
    onEvent({
      type: 'status',
      text: `正在用看图模型 ${label} 识别图片（共 ${list.length} 张）…`,
      activeModel: label,
      activeRole: 'vision'
    });
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
          lang,
          apiKey: vis.apiKey,
          protocol: vis.protocol
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
    if (role === 'code' && codeWorker) continue;
    const candidates = assembly.roleCandidates(vs, role);
    if (!candidates.length) continue;
    const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
    let used = false;
    for (const cand of candidates) {
      const helperCfg = assembly.slotToModelCfg(cand.slot, vs);
      if (!helperCfg) continue;
      if (helperCfg.type === 'zbaingModule') helperCfg._helperRole = role;
      const sameAsPrimary = isLocalGguf(helperCfg) && isLocalGguf(modelCfg)
        ? (helperCfg.model || helperCfg.modelPath) === (modelCfg.model || modelCfg.modelPath)
        : helperCfg.id && helperCfg.id === modelCfg.id;
      if (sameAsPrimary) continue;
      const helperLabel = helperCfg.model || helperCfg.name || role;
      const srcHint = cand.source === 'assembly' ? '组合' : (cand.source === 'fallback' ? '备用' : '全局');
      onEvent({
        type: 'status',
        text: `正在用${roleName}模型 ${helperLabel}（${srcHint}）预处理…`,
        activeModel: helperLabel,
        activeRole: role
      });
      diag.log('agent', '路由到辅助模型', { role, model: helperLabel, source: cand.source });
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
          onWait: (sec) => onEvent({
            type: 'status',
            text: `${roleName}模型处理中 · ${sec}`,
            activeModel: helperLabel,
            activeRole: role
          })
        });
        const out = String(msg?.content || '').trim();
        if (!out) throw new Error('辅助模型无输出');
        extraTexts.push(`—— 以下是${roleName}模型「${helperLabel}」的预处理结果 ——`);
        extraTexts.push(out.slice(0, 12000));
        onEvent({ type: 'think', text: `${roleName}预处理完成（${srcHint}）` });
        used = true;
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        onEvent({ type: 'think', text: `${roleName}（${srcHint}）失败：${e.message}` });
        diag.log('agent', '辅助模型失败，尝试下一候选', { role, source: cand.source, message: e && e.message });
      }
    }
    if (!used) { /* 全部失败则跳过，主模型继续 */ }
  }

  // 只有 zbaing 系本地引擎（无自带联网）才注入本地联网搜索；其他模型自带联网能力，跳过以省时省 token
  if (isZbaingAi(modelCfg) || isZbaingModule(modelCfg)) {
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
  }

  const hasNativeImages = parts.some((p) => p.type === 'image_url');
  const hasHelperText = extraTexts.some((t) => t.includes('【图片识别结果】'));
  const visionMode = hasHelperText && hasNativeImages ? 'mixed' : hasNativeImages ? 'native' : hasHelperText ? 'helper' : '';

  if (workspace) {
    const remember = memory.parseRememberDirective(userText);
    if (remember) {
      try {
        if (/喜欢|偏好|习惯|总是|不要给我|请用/.test(remember)) {
          await memoryGlobal.addPref({ summary: remember, pinned: true, source: 'user' });
          onEvent({ type: 'think', text: `已写入全局偏好：${remember.slice(0, 80)}` });
        } else {
          memory.addUserMemory(workspace, {
            summary: remember,
            paths: contextPaths || [],
            pinned: true,
            kind: 'pin'
          });
          onEvent({ type: 'think', text: `已钉住长期记忆：${remember.slice(0, 80)}` });
        }
      } catch (e) {
        diag.log('memory', '显式记住失败', { message: e && e.message });
      }
    }
  }

  if (isZbaingAi(modelCfg) && !workspace && (zbaingWantsExplore(userText) || zbaingSearchQuery(userText))) {
    // 不往对话里塞「请先打开」模板。workspace 空由引擎自己生成。
  } else if (isZbaingAi(modelCfg) && workspace && zbaingWantsExplore(userText)) {
    onEvent({ type: 'status', text: '正在读取工作区…' });
    try {
      await zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', 'zbaing 工作区预读失败', { message: e && e.message });
    }
  } else if (isZbaingAi(modelCfg) && workspace && zbaingSearchQuery(userText)) {
    onEvent({ type: 'status', text: '正在搜索代码…' });
    try {
      await zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', 'zbaing 搜索预读失败', { message: e && e.message });
    }
  }

  const workingMemoryRef = { current: compact.normalizeWorking(workingMemory) };
  let rollingSummary = String(contextSummary || '');
  let hist = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.text || ''
  }));
  // 本地裁掉过早对话，不另调模型；长会话每轮少带几十万 token，小改动才不会等很久
  {
    const packed = compact.trimHistoryLocal(hist, rollingSummary);
    hist = packed.history;
    rollingSummary = packed.contextSummary;
    if (packed.didTrim) onEvent({ type: 'think', text: '已裁掉更早对话，只保留最近几轮全文' });
  }

  let memoryEntries = [];
  let globalPrefs = [];
  try {
    memoryEntries = workspace
      ? await memory.recall(workspace, { userText, paths: contextPaths || [] })
      : [];
  } catch {
    memoryEntries = workspace ? memory.recallSync(workspace, { userText, paths: contextPaths || [] }) : [];
  }
  try {
    globalPrefs = await memoryGlobal.recallPrefs(userText, contextPaths || []);
  } catch {
    globalPrefs = memoryGlobal.listPrefs().filter((p) => p.pinned).slice(0, 6);
  }
  const profile = memoryGlobal.getProfile();

  const userContent = [];
  const textBlock = [userText, extraTexts.join('\n\n'), ctxChunks.join('\n\n')].filter(Boolean).join('\n\n');
  if (parts.length) {
    userContent.push({ type: 'text', text: textBlock || '请查看附件' });
    userContent.push(...parts);
  }

  const zbaingChat = isZbaingAi(modelCfg);
  const mergeTurns = (arr) => {
    const slim = [];
    for (const m of arr || []) {
      if (slim.length && slim[slim.length - 1].role === 'user' && m.role === 'user') {
        slim[slim.length - 1] = m;
      } else {
        slim.push(m);
      }
    }
    return slim;
  };
  const slimZbaingHist = (histMsgs) => {
    const junk = /^(好。|嗯。|行。|好|嗯|好的。)$/;
    const poison = /没有返回内容|没有生成到文字|只算我|贴的 zbaing/i;
    const kept = (histMsgs || []).filter((m) => {
      if (m.role === 'user') return !!String(m.content || '').trim();
      if (m.role !== 'assistant') return false;
      const t = String(m.content || '').trim();
      if (!t || junk.test(t) || poison.test(t)) return false;
      return true;
    });
    return mergeTurns(kept).slice(-6);
  };
  // 较早的工具结果压成短摘要，避免每轮重发巨量旧内容（最近 3 条保留全文）
  const ageToolHistory = (histMsgs) => {
    const toolIdx = [];
    (histMsgs || []).forEach((m, i) => { if (m.role === "tool") toolIdx.push(i); });
    const keepFrom = toolIdx.length > 3 ? toolIdx[toolIdx.length - 3] : -1;
    return (histMsgs || []).map((m, i) => {
      if (m.role !== "tool" || i >= keepFrom) return m;
      const text = String(m.content || "");
      if (text.includes("【文件】") || text.includes("【全文】")) return m;
      if (text.length <= 600) return m;
      return Object.assign({}, m, { content: text.slice(0, 600) + "\n…（较早的工具结果已省略，需要时重新调用工具）" });
    });
  };
  const buildMessages = (histMsgs, summaryText) => {
    const agedHist = ageToolHistory(histMsgs);
    const userMsg = { role: 'user', content: parts.length ? userContent : textBlock };
    if (zbaingChat) {
      return mergeTurns([...slimZbaingHist(histMsgs), userMsg]);
    }
    return [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspace,
        rules,
        skill,
        extra,
        allSkills,
        persona,
        visionMode,
        visionBridge: vis.model || '',
        lang,
        memoryEntries,
        globalPrefs,
        profile,
        workingMemory: workingMemoryRef.current,
        contextSummary: summaryText,
        zbaingBridge: isZbaingAi(modelCfg),
        brainHandsOff: !!codeWorker
      })
    },
    ...agedHist,
    userMsg
  ];
  };

  let messages = buildMessages(hist, rollingSummary);

  onEvent({ type: 'roster', models: buildRoster(vs, modelCfg) });
  const modelLabel = modelCfg.model || modelCfg.name || modelCfg.id || '模型';
  if (isZbaingAi(modelCfg)) {
    onEvent({ type: 'status', text: `正在调用 ${modelLabel}...` });
  } else {
    onEvent({ type: 'think', text: `正在调用 ${modelLabel}...` });
  }
  let zbaingMeta = null;
  const trackEvent = (ev) => {
    if (ev.type === 'zbaing_meta') {
      zbaingMeta = { source: ev.source, prompt: ev.prompt, minConf: ev.minConf };
    }
    onEvent(ev);
  };
  let finalText;
  try {
    finalText = await agentLoop({
      modelCfg,
      messages,
      workspace,
      extra,
      snap,
      onEvent: trackEvent,
      signal,
      lang,
      workingMemoryRef,
      waitForUserAnswer,
      maxRounds: roundLimit,
      unlimitedRounds: !!unlimitedRounds,
      toolSpec: loopTools,
      workers: loopWorkers,
      roleTag: 'brain',
      depth: 0,
      planningName
    });
  } catch (e) {
    if (compact.isContextOverflowError(e)) {
      onEvent({ type: 'think', text: '上下文爆了，正在压缩后重试…' });
      const packed = await compact.compactHistory({
        history: hist,
        contextSummary: rollingSummary,
        modelCfg,
        summarySlotCfg: compact.pickSummaryCfg(vs, modelCfg),
        completeFn: completeWithFallback,
        lang,
        signal,
        onEvent
      });
      hist = packed.history;
      rollingSummary = packed.contextSummary;
      messages = buildMessages(hist, rollingSummary);
      finalText = await agentLoop({
        modelCfg,
        messages,
        workspace,
        extra,
        snap,
        onEvent: trackEvent,
        signal,
        lang,
        workingMemoryRef,
        waitForUserAnswer,
        maxRounds: roundLimit,
        unlimitedRounds: !!unlimitedRounds,
        toolSpec: loopTools,
        workers: loopWorkers,
        roleTag: 'brain',
        depth: 0,
        planningName
      });
    } else {
      throw e;
    }
  } finally {
    try { require('./desktop-hand').release(); } catch { /* 没开桌面操作时不用收尾 */ }
  }

  const changes = snap.current?.manifest?.changes || [];
  if (snap.current && changes.length) {
    snapshot.captureAfter(workspace, snap.current);
    onEvent({
      type: 'files',
      snapshotId: snap.current.id,
      changes
    });
  }
  const result = {
    text: finalText,
    snapshotId: snap.current?.id || null,
    changes,
    workingMemory: workingMemoryRef.current,
    contextSummary: rollingSummary,
    zbaingMeta
  };
  onEvent({
    type: 'done',
    text: finalText,
    snapshotId: result.snapshotId,
    changes,
    workingMemory: result.workingMemory,
    contextSummary: rollingSummary,
    zbaingMeta
  });

  // 记忆提炼不挡收工：改文件后的额外模型调用放到后台，界面先解锁
  const afterWork = async () => {
    if (signal?.aborted) return;
    if (workspace && changes.length) {
      try {
        const extractMsg = await completeWithFallback({
          modelCfg,
          messages: [
            { role: 'user', content: memory.extractPrompt({
              userText,
              changePaths: changes.map((c) => c.path),
              assistantText: finalText,
              lang
            }) }
          ],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: () => {}
        });
        const parsed = memory.parseExtractJson(asText(extractMsg?.content));
        if (parsed.length) memory.mergeEntries(workspace, parsed, { source: 'auto' });
      } catch (e) {
        if (e.name !== 'AbortError') diag.log('memory', '自动提炼失败', { message: e && e.message });
      }
    }
    // 纯闲聊才更新画像；改代码那轮再跑一次等于白等
    if (!changes.length && !isZbaingAi(modelCfg)) {
      try {
        const patchMsg = await completeWithFallback({
          modelCfg,
          messages: [{ role: 'user', content: memoryGlobal.profileExtractPrompt(userText, finalText) }],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: () => {}
        });
        const patch = memoryGlobal.parseProfilePatch(asText(patchMsg?.content));
        if (patch && Object.keys(patch).length) memoryGlobal.mergeProfilePatch(patch);
      } catch (e) {
        if (e.name !== 'AbortError') diag.log('memory', '画像更新失败', { message: e && e.message });
      }
    }
  };
  afterWork().catch((e) => diag.log('memory', '收工后处理失败', { message: e && e.message }));
  return result;
}

function listSkills(appRoot, workspace, order) {
  return skillsLib.loadAll(path.join(appRoot, 'skills'), workspace, order);
}

function listRules(appRoot, workspace) {
  return skillsLib.loadRules(path.join(appRoot, 'rules'), workspace);
}

// 用当前模型为项目地图的每个模块生成一句中文职责描述（AI 绘制）
async function describeProjectMap(modelCfg, mapData) {
  if (!modelCfg || !mapData || !Array.isArray(mapData.nodes) || !mapData.nodes.length) return mapData;
  const items = mapData.nodes.map((n) => ({ path: n.path, ext: n.ext || '', deps: (n.deps || []).slice(0, 10) }));
  const sys = {
    role: 'system',
    content: '你是项目地图分析助手。下面给出一个项目的文件模块清单及依赖关系。请为每个模块用一句中文（不超过 40 字）概括它承担的职责。只输出一个 JSON 数组，元素为 {"path": 原路径, "desc": 一句中文描述}，不要输出任何额外文字或代码块标记。'
  };
  const user = {
    role: 'user',
    content: '模块清单（path 为模块路径，deps 为它依赖的模块路径）：\n' + JSON.stringify(items)
  };
  const msg = await completeWithFallback({ modelCfg, messages: [sys, user], noTools: true });
  const raw = (msg && msg.content != null)
    ? (typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map((c) => (c && c.text) || '').join('') : ''))
    : '';
  const arr = parseProjectMapJsonArray(raw);
  if (!arr) { diag.log('map', 'AI 返回的地图描述无法解析，保留静态结果'); return mapData; }
  const byPath = new Map();
  for (const it of arr) {
    if (it && it.path && it.desc) byPath.set(String(it.path), String(it.desc).slice(0, 80));
  }
  let filled = 0;
  for (const n of mapData.nodes) {
    const d = byPath.get(n.path);
    if (d) { n.desc = d; filled++; }
  }
  diag.log('map', 'AI 绘制完成', { filled, total: mapData.nodes.length });
  return mapData;
}

// 从模型可能夹带代码块或前后文字的回复里抽出 JSON 数组
function parseProjectMapJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}


module.exports = { runTurn, listSkills, listRules, toolsSpec, describeProjectMap };

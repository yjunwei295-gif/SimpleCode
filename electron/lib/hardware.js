const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const GB = 1024 * 1024 * 1024;

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 显存优先问 nvidia-smi（最准），拿不到再退到系统的显卡信息 */
async function detectGpu() {
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  const line = smi.split(/\r?\n/).find((l) => l.trim());
  if (line) {
    const [name, mb] = line.split(',').map((s) => s.trim());
    const vramGB = Number(mb) / 1024;
    if (name && Number.isFinite(vramGB) && vramGB > 0) {
      return { name, vramGB: Math.round(vramGB * 10) / 10, source: 'nvidia-smi' };
    }
  }
  if (process.platform !== 'win32') return { name: '', vramGB: 0, source: '未知' };

  // Win32_VideoController 的 AdapterRAM 超过 4GB 会溢出，所以先读注册表里的 qwMemorySize
  const ps = await run('powershell', ['-NoProfile', '-Command',
    "$c=Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name;"
    + "$k=Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue |"
    + " Where-Object { $_.'HardwareInformation.qwMemorySize' } | Select-Object -First 1 -ExpandProperty 'HardwareInformation.qwMemorySize';"
    + "\"$c|$k\""
  ], 10000);
  const [name = '', qw = ''] = ps.trim().split('|');
  const vramGB = Number(qw) > 0 ? Math.round((Number(qw) / GB) * 10) / 10 : 0;
  return { name: name.trim(), vramGB, source: vramGB ? '系统注册表' : '系统信息' };
}

function diskFreeGB(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Math.round((st.bsize * st.bavail / GB) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * 采集本机配置
 * @param {string} modelsDir 模型目录，用来算所在盘剩余空间
 */
async function detect(modelsDir) {
  const cpus = os.cpus() || [];
  const gpu = await detectGpu();
  return {
    cpu: { name: (cpus[0]?.model || '未知 CPU').trim(), cores: cpus.length },
    memTotalGB: Math.round((os.totalmem() / GB) * 10) / 10,
    memFreeGB: Math.round((os.freemem() / GB) * 10) / 10,
    gpu,
    diskFreeGB: diskFreeGB(modelsDir || os.homedir()),
    modelsDir: modelsDir || ''
  };
}

// 候选模型清单。体积是 Q4_K_M 的大致值，真实体积在打开仓库时会用接口返回的数据覆盖
const CATALOG = [
  { id: 'coder-1.5b', name: 'Qwen2.5-Coder 1.5B', repo: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 1.1, purposes: ['code'], desc: '最小的代码模型，低配也能跑，适合补全和小改动' },
  { id: 'coder-7b', name: 'Qwen2.5-Coder 7B', repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 4.7, purposes: ['code'], desc: '写代码的主力档，质量和资源占用比较平衡' },
  { id: 'coder-14b', name: 'Qwen2.5-Coder 14B', repo: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 9.0, purposes: ['code'], desc: '代码能力更强，需要较大内存或显存' },
  { id: 'coder-32b', name: 'Qwen2.5-Coder 32B', repo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 19.9, purposes: ['code'], desc: '本地代码模型的高配档，对硬件要求高' },
  { id: 'chat-1.5b', name: 'Qwen2.5 1.5B', repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 1.1, purposes: ['chat'], desc: '轻量对话模型，速度快，适合低配机器' },
  { id: 'chat-3b', name: 'Qwen2.5 3B', repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 2.0, purposes: ['chat'], desc: '日常问答和短文写作够用' },
  { id: 'chat-7b', name: 'Qwen2.5 7B', repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 4.7, purposes: ['chat'], desc: '通用对话和写作的主力档' },
  { id: 'chat-14b', name: 'Qwen2.5 14B', repo: 'bartowski/Qwen2.5-14B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 9.0, purposes: ['chat'], desc: '长文和复杂推理更稳，需要较大内存' }
];

const UNSUPPORTED = {
  image: '看图请在「文件 → 模型组合」挂上视觉 GGUF 和 mmproj；引擎插件会自动下载，不会把原图发给 DeepSeek。',
  video: '本地引擎不支持视频，市面上的 GGUF 也没有可直接用于视频理解的方案。视频相关需求请改用支持视频的在线服务。'
};

/**
 * 按用途和本机配置给出模型建议
 * @param {'code'|'chat'|'image'|'video'} purpose 用途
 * @param {object} hw detect() 的结果
 */
function suggest(purpose, hw) {
  if (UNSUPPORTED[purpose]) {
    return { supported: false, reason: UNSUPPORTED[purpose], items: [] };
  }
  const vram = hw?.gpu?.vramGB || 0;
  const ramTotal = hw?.memTotalGB || 0;
  // 给系统和其它程序留 4GB，剩下的才是模型能用的
  const usableRam = Math.max(ramTotal - 4, 2);
  const disk = hw?.diskFreeGB || 0;

  const items = CATALOG.filter((m) => m.purposes.includes(purpose)).map((m) => {
    let fit = 'no';
    if (m.sizeGB + 1.0 <= vram) fit = 'gpu';
    else if (m.sizeGB + 1.5 <= usableRam) fit = 'ram';
    else if (m.sizeGB + 0.5 <= ramTotal - 2) fit = 'tight';
    return { ...m, fit, diskEnough: disk === 0 || disk > m.sizeGB + 1 };
  });

  // 推荐优先看显存：能整个放进显存的最大模型最好用。
  // 显存放不下就只能靠 CPU 推理，超过这个体积会慢到没法用，不能只因为「内存装得下」就推荐。
  const CPU_PRACTICAL_GB = 5;
  const usable = items.filter((m) => m.diskEnough);
  const best = usable.filter((m) => m.fit === 'gpu').sort((a, b) => b.sizeGB - a.sizeGB)[0]
    || usable.filter((m) => m.fit === 'ram' && m.sizeGB <= CPU_PRACTICAL_GB).sort((a, b) => b.sizeGB - a.sizeGB)[0]
    || usable.filter((m) => m.fit === 'ram').sort((a, b) => a.sizeGB - b.sizeGB)[0];

  for (const m of items) {
    if (m.fit === 'gpu') {
      m.tier = best && m.id === best.id ? '推荐' : '可选';
      m.note = '能整个放进显存，速度快';
    } else if (m.fit === 'ram' && m.sizeGB <= CPU_PRACTICAL_GB) {
      m.tier = best && m.id === best.id ? '推荐' : '可选';
      m.note = vram > 0 ? '显存放不下，用 CPU 跑，速度中等' : '用内存跑，速度中等';
    } else if (m.fit === 'ram') {
      m.tier = best && m.id === best.id ? '推荐' : '可选';
      m.note = '内存装得下，但显存放不下，只能用 CPU 跑，会明显偏慢';
    } else if (m.fit === 'tight') {
      m.tier = '勉强能跑';
      m.note = '内存刚够，生成很慢，长对话可能撑不住';
    } else {
      m.tier = '跑不动';
      m.note = `需要约 ${(m.sizeGB + 1.5).toFixed(1)}GB 可用内存，本机不够`;
    }
    if (!m.diskEnough) m.note += `；模型目录所在盘只剩 ${disk}GB，空间不足`;
  }
  return { supported: true, items };
}

module.exports = { detect, suggest, CATALOG };

const assembly = require('./assembly');

const SOFT_LIMIT = 24000;
const KEEP_TURNS = 6;
const SUMMARY_MAX = 4000;

function emptyWorking() {
  return {
    goal: '',
    openQuestions: [],
    focusPaths: [],
    scratch: []
  };
}

function normalizeWorking(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    goal: String(w.goal || '').slice(0, 300),
    openQuestions: Array.isArray(w.openQuestions)
      ? w.openQuestions.map(String).filter(Boolean).slice(0, 12)
      : [],
    focusPaths: Array.isArray(w.focusPaths)
      ? [...new Set(w.focusPaths.map((p) => String(p).replace(/\\/g, '/')))].slice(0, 30)
      : [],
    scratch: Array.isArray(w.scratch)
      ? w.scratch.map(String).filter(Boolean).slice(0, 12)
      : []
  };
}

function formatWorking(w, { english = false } = {}) {
  const m = normalizeWorking(w);
  if (!m.goal && !m.openQuestions.length && !m.focusPaths.length && !m.scratch.length) return '';
  const lines = [];
  if (english) {
    if (m.goal) lines.push(`Goal: ${m.goal}`);
    if (m.openQuestions.length) lines.push(`Open: ${m.openQuestions.join(' | ')}`);
    if (m.focusPaths.length) lines.push(`Focus files: ${m.focusPaths.join(', ')}`);
    if (m.scratch.length) lines.push(`Notes: ${m.scratch.join(' | ')}`);
    return `## Working memory (this chat)\n${lines.join('\n')}`;
  }
  if (m.goal) lines.push(`目标：${m.goal}`);
  if (m.openQuestions.length) lines.push(`未决：${m.openQuestions.join(' ｜ ')}`);
  if (m.focusPaths.length) lines.push(`焦点文件：${m.focusPaths.join(', ')}`);
  if (m.scratch.length) lines.push(`要点：${m.scratch.join(' ｜ ')}`);
  return `## 工作记忆（本会话）\n${lines.join('\n')}`;
}

function patchWorking(current, patch) {
  const w = normalizeWorking(current);
  if (!patch || typeof patch !== 'object') return w;
  if (typeof patch.goal === 'string') w.goal = patch.goal.slice(0, 300);
  if (Array.isArray(patch.openQuestions)) {
    w.openQuestions = patch.openQuestions.map(String).filter(Boolean).slice(0, 12);
  }
  if (Array.isArray(patch.focusPaths)) {
    w.focusPaths = [...new Set(patch.focusPaths.map((p) => String(p).replace(/\\/g, '/')))].slice(0, 30);
  }
  if (Array.isArray(patch.scratch)) {
    w.scratch = patch.scratch.map(String).filter(Boolean).slice(0, 12);
  }
  if (typeof patch.addScratch === 'string' && patch.addScratch.trim()) {
    w.scratch = [...w.scratch, patch.addScratch.trim()].slice(-12);
  }
  if (typeof patch.addQuestion === 'string' && patch.addQuestion.trim()) {
    w.openQuestions = [...new Set([...w.openQuestions, patch.addQuestion.trim()])].slice(0, 12);
  }
  return w;
}

function msgChars(m) {
  if (!m) return 0;
  if (typeof m.content === 'string') return m.content.length;
  if (typeof m.text === 'string') return m.text.length;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (p?.text || p?.image_url?.url || '')).join('').length;
  }
  return 0;
}

function estimateSize({ systemText = '', history = [], userText = '' }) {
  let n = String(systemText || '').length + String(userText || '').length;
  for (const m of history || []) n += msgChars(m) + 16;
  return n;
}

function needsCompact({ systemText, history, userText, contextSummary }) {
  const base = estimateSize({ systemText, history, userText }) + String(contextSummary || '').length;
  return base > SOFT_LIMIT;
}

function splitHistory(history, keepTurns = KEEP_TURNS) {
  const list = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (list.length <= keepTurns * 2) {
    return { keep: list, older: [] };
  }
  const keepCount = keepTurns * 2;
  return {
    older: list.slice(0, list.length - keepCount),
    keep: list.slice(list.length - keepCount)
  };
}

function formatDialog(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'user' ? '用户' : '助手';
    const text = typeof m.content === 'string' ? m.content : (m.text || '');
    return `${role}：${String(text).slice(0, 2000)}`;
  }).join('\n\n');
}

function summarizePrompt({ oldSummary, olderMessages, lang }) {
  const en = lang && lang.code && lang.code !== 'zh' && lang.code !== 'zh-Hant';
  if (en) {
    return `Compress earlier chat into a rolling context summary for the coding agent.
Keep: goals, decisions, changed file paths, constraints, open questions. Do not invent.
Max ${SUMMARY_MAX} characters. Output plain text only.

Previous summary:
${String(oldSummary || '(none)').slice(0, 3000)}

Older messages:
${formatDialog(olderMessages).slice(0, 12000)}`;
  }
  return `把更早的对话压缩成滚动上下文摘要，供编程助手继续用。
必须保留：目标、结论、改过的路径、用户约束、未决问题。禁止编造。
不超过 ${SUMMARY_MAX} 字。只输出摘要正文。

旧摘要：
${String(oldSummary || '（无）').slice(0, 3000)}

更早对话：
${formatDialog(olderMessages).slice(0, 12000)}`;
}

function mergeSummary(oldSummary, newPart) {
  const s = String(newPart || '').trim() || String(oldSummary || '').trim();
  return s.slice(0, SUMMARY_MAX);
}

function formatSummaryForPrompt(summary, { english = false } = {}) {
  const s = String(summary || '').trim();
  if (!s) return '';
  return english
    ? `## Earlier conversation summary\n${s}`
    : `## 更早对话摘要\n${s}`;
}

function isContextOverflowError(err) {
  const msg = String(err && err.message || err || '');
  return /No sequences left|context.*(length|overflow|exceed)|maximum context|prompt.*(too long|too large)|上下文/i.test(msg);
}

/**
 * 压缩历史：返回 keep 消息 + 新摘要
 */
async function compactHistory({
  history,
  contextSummary,
  modelCfg,
  summarySlotCfg,
  completeFn,
  lang,
  signal,
  onEvent
}) {
  const { older, keep } = splitHistory(history);
  if (!older.length) {
    return { history: keep, contextSummary: contextSummary || '', didCompact: false };
  }
  if (onEvent) onEvent({ type: 'think', text: '上下文过长，已自动总结更早对话' });
  if (onEvent) onEvent({ type: 'context_compacted' });
  if (onEvent) onEvent({ type: 'status', text: '正在压缩更早对话…' });
  const cfg = summarySlotCfg || modelCfg;
  const prompt = summarizePrompt({ oldSummary: contextSummary, olderMessages: older, lang });
  const msg = await completeFn({
    modelCfg: cfg,
    messages: [{ role: 'user', content: prompt }],
    noTools: true,
    signal,
    onDelta: () => {},
    onWait: () => {}
  });
  const text = String(msg?.content || msg?.text || '').trim();
  const nextSummary = mergeSummary(contextSummary, text);
  return { history: keep, contextSummary: nextSummary, didCompact: true };
}

function pickSummaryCfg(vs, primaryCfg) {
  if (!vs) return primaryCfg;
  const hit = assembly.resolveRole(vs, 'summary');
  if (!hit?.slot) return primaryCfg;
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  return cfg || primaryCfg;
}

module.exports = {
  SOFT_LIMIT,
  KEEP_TURNS,
  emptyWorking,
  normalizeWorking,
  formatWorking,
  patchWorking,
  estimateSize,
  needsCompact,
  splitHistory,
  compactHistory,
  formatSummaryForPrompt,
  isContextOverflowError,
  pickSummaryCfg
};

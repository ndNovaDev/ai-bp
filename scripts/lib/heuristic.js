// 本地启发式预筛器。
// 目的:对**显然低值**的会话不再调用 Haiku,直接本地打低分写入索引。
// 这是省 Haiku 调用的关键手段(初步估算可省 30-50%),
// 但也是误判风险点 — 阈值故意压得很严,只有当多个信号同时为零才放行,
// 边界模糊的一律继续走 Haiku。
//
// 触发后返回与 scoreCard 同形的结果对象;不命中返回 null。
// 想完全关掉:`AIBP_NO_HEURISTIC=1`,或 scan 时加 --rescore 不影响(本模块仍会先尝试)。

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function totalToolCalls(tools) {
  if (!tools) return 0;
  let n = 0;
  for (const k of Object.keys(tools)) n += tools[k] || 0;
  return n;
}

function hasEditTool(tools) {
  if (!tools) return false;
  return EDIT_TOOLS.some((t) => (tools[t] || 0) > 0);
}

// 返回值形状与 lib/score.js#scoreCard 输出对齐,scan.js 可以无差别写入索引。
function tryHeuristicScore(card) {
  if (process.env.AIBP_NO_HEURISTIC === '1') return null;
  if (!card) return null;

  const turns = card.turns || 0;
  const totalTools = totalToolCalls(card.tools);
  const filesCount = (card.filesEdited || []).length;
  const commits = (card.gitCommitsInWindow || []).length;

  // 规则 1:典型闲聊/单问单答 — 几乎肯定是低值
  // 极少轮次 + 完全没动过代码 + git 窗口内零 commit。
  if (turns <= 3 && !hasEditTool(card.tools) && filesCount === 0 && commits === 0) {
    return {
      score: 10,
      summary: '短对话(≤3 轮),无文件编辑,git 窗口内无 commit。本地启发式判定为低值会话。',
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  // 规则 2:工具用得很少且零产出
  // 区别于规则 1:可能轮次稍多但仍是聊天/查询型。
  // 仍要求没碰过 Edit/Write — 调过编辑工具就给 Haiku 看,即便没产出。
  if (totalTools < 5 && !hasEditTool(card.tools) && filesCount === 0 && commits === 0 && turns < 6) {
    return {
      score: 15,
      summary: '少量工具调用(<5 次),零文件改动,git 窗口内无 commit。本地启发式判定为低值会话。',
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  return null;
}

module.exports = { tryHeuristicScore, totalToolCalls, hasEditTool, EDIT_TOOLS };

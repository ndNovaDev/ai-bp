// 本地启发式预筛器。
// 目的:对**显然低值**的会话不再调用 Haiku,直接本地打低分写入索引。
// 这是省 Haiku 调用的关键手段(初步估算可省 30-50%),
// 但也是误判风险点 — 阈值故意压得很严,只有当多个信号同时为零才放行,
// 边界模糊的一律继续走 Haiku。
//
// 触发后返回与 scoreCard 同形的结果对象;不命中返回 null。
// 想完全关掉:`AIBP_NO_HEURISTIC=1`,或 scan 时加 --rescore 不影响(本模块仍会先尝试)。

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const NO_EDIT_NOTE = '没有任何文件改动(代码/文档/配置/脚本都没动)';

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
  // 关键护栏:`filesCount === 0 && !hasEditTool` — 任何文件改动(代码/文档/skill/
  // command/dotfile/脚本)都会让会话绕过这条规则,交给 Haiku 评。"无 commit" 不是
  // 单独的低值信号 — 写文档/skill/dotfile 这类合法产出本来就不进 git。
  if (turns <= 3 && !hasEditTool(card.tools) && filesCount === 0 && commits === 0) {
    return {
      score: 10,
      summary: `短对话(≤3 轮),${NO_EDIT_NOTE}。本地启发式判定为低值会话。`,
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  // 规则 2:工具用得很少且零产出
  // 区别于规则 1:可能轮次稍多但仍是聊天/查询型。
  // 同样要求没碰过 Edit/Write 且 filesCount === 0 — 任何文件改动都放行给 Haiku。
  if (totalTools < 5 && !hasEditTool(card.tools) && filesCount === 0 && commits === 0 && turns < 6) {
    return {
      score: 15,
      summary: `少量工具调用(<5 次),${NO_EDIT_NOTE},轮次也低。本地启发式判定为低值会话。`,
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  // 规则 3:中等规模但零持久化产出
  // 实测自 0.1.40:本地 261 个 Haiku-scored 会话里,凡命中
  //   filesEdited==0 && commits==0 && totalTools<10 && turns<12 && !hasEdit
  // 的 29 条,Haiku 给的分数全在 0-59 区间(主要在 10-30),0 条达到 60(周报候选门槛)。
  // 0.1.45 放宽到 turns<20 && totalTools<15 — 同样无任何文件改动 + 无 commit,这个范围
  // 在实测数据里仍全部 < 60 分。零持久化的查询/排错/请教即便聊更久也不出 gold。
  if (
    !hasEditTool(card.tools) &&
    filesCount === 0 &&
    commits === 0 &&
    totalTools < 15 &&
    turns < 20
  ) {
    return {
      score: 20,
      summary: `中等长度对话(<20 轮 / <15 次工具调用),${NO_EDIT_NOTE}。本地启发式判定为低值会话。`,
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  // 规则 4(0.1.45 新增):小规模改文件但完全没落地。
  // 改了 1-2 个文件、没 commit、轮次低 — 通常是"改了个 dotfile / 试试 prompt 模板 /
  // 改两行又回滚"。给 30 分(略高于规则 3,因为有动作)。
  // 触发上限刻意压得严:filesCount ≤ 2 是关键护栏 — 改 3+ 文件可能是真的多文件
  // 重构没来得及 commit,放给 Haiku 评。
  if (
    hasEditTool(card.tools) &&
    filesCount > 0 &&
    filesCount <= 2 &&
    commits === 0 &&
    turns < 10
  ) {
    return {
      score: 30,
      summary: `小规模改动(≤2 个文件 / <10 轮)且无 commit。本地启发式判定为低落地度会话。`,
      highlights: [],
      tags: ['chat'],
      cost: 0,
      model: 'heuristic-v1',
    };
  }

  return null;
}

module.exports = { tryHeuristicScore, totalToolCalls, hasEditTool, EDIT_TOOLS };

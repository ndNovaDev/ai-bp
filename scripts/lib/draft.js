// 周报起草:两阶段 + 一轮采访。
//   buildProbePrompt(...)    → 出"初稿 + 采访问题"用的 prompt 文本
//   <slash command 把 prompt 喂给主对话的 Claude;主 Claude 生成 STAR + 4 道题>
//   <slash command 调 AskUserQuestion 一次性问完 4 题>
//   buildFinalizePrompt(...) → 出"最终 markdown"用的 prompt 文本
//   <主 Claude 应用 prompt,Write 到 ~/.ai-best-practice/weekly/>
//   detectBanned(md)         → 后置检测 LLM 套路短语;命中由 slash command 让主 Claude 重写一次
//
// 起草工作完全在主对话内进行,不再 spawn `claude -p` 子进程 — 一来主 Claude 通常是
// 1M context 模型(evidencePack 多案例 + jsonl 头尾会爆 200K 标准窗口),二来子进程的
// 1M 变体在 Anthropic 走"长上下文额外用量"额度,容易被 429 卡住。共享主会话的鉴权和
// 模型选择,零额外配置。
//
// 假想敌:公司内部的"AI 最佳实践审计 AI",它从全公司每周成百上千份提交里挑真金,
// 不奖励"会写报告的人"。见 AUDITOR_LENS。

const AUDITOR_LENS = `你写的这份周报会被一个独立的"AI 最佳实践审计 AI"逐条评估。它的 7 条探针你必须心里有数:
1. 真实性:它在找编造痕迹、套话、空 artifact。引用具体 commit hash / sessionId / 文件路径,但不复述其内容。
2. 问题难度:它会识破伪需求("自动化打开文档"那种)。用"如果不做会怎样"的反事实交代代价(时间/质量/重复劳动)。
3. AI 协作成熟度:它在判断作者是"把 AI 当聊天"还是"把 AI 当工程师"。要让叙事里自然出现 plan → 分解 → 工具编排 → 验证的链路,不要强调"我让 AI 做了 X"。
4. 沉淀深度:它在区分一次性脚本和可分发 artifact。是否产出 plugin / skill / hook / 文档,且别人能直接复用。
5. 杠杆:它在找这次产出对未来工作的复利。一两句点到"下次类似场景的边际成本",不画饼,只指出机制。
6. 成本诚实度:它对虚报 ROI、口号化收益敏感。量化项老老实实写区间或"未量化",不编百分比。
7. 故事完整度:它会扣 STAR 塌方(只剩 Action,没 Task 和 Result)的分。四段都要齐全,本次没做的段直接写"本次未做"。

写作风格要求:
- 论文级:每句话能被审计 AI 单独抠出来评估,经得起推敲。
- 平实白话,主体写散文段落而不是 bullet 列表。STAR 四段以小标题分。
- 中文表达,避免翻译腔。不要"使用了 X 工具"、"调用了 Y"、"通过 X 完成 Y" 这种 LLM 句式。
- 隐性表达成熟度和杠杆,不要喊口号。"未来这件事的边际成本从 N 小时变成 N 分钟"比"极大地提升了效率"强。
- 不用 emoji。不用独立的 \`---\` 分隔线。`;

// 这些短语命中就触发 finalize 重写一次。基于实际看到的 LLM 套路梳理。
const BANNED_PHRASES = [
  '使用了',
  '调用了',
  '可以说',
  '在一定程度上',
  '总的来说',
  '综上所述',
  '极大地',
  '大大地',
  '众所周知',
  '不可否认',
];

function detectBanned(markdown) {
  const hits = [];
  for (const p of BANNED_PHRASES) {
    if (markdown.includes(p)) hits.push(p);
  }
  return hits;
}

function titleToSlug(title) {
  if (!title) return 'untitled';
  // 保留中英数字,其余空白和标点都成连字符
  let s = String(title).trim().toLowerCase();
  s = s.replace(/[\s　]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}\-]/gu, '');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s) return 'untitled';
  return s.length > 60 ? s.slice(0, 60).replace(/-+$/, '') : s;
}

function extractTitle(markdown) {
  const m = /^#\s+(.+)$/m.exec(markdown || '');
  return m ? m[1].trim() : 'untitled';
}

// ===== 提示词模板 =====
// 这些函数返回**纯字符串**:slash command 拿到字符串后,作为给主 Claude 的下一条
// 指令喂进对话上下文。主 Claude 在它自己的下一次回复里产出 STAR + 4 题 / 终稿。
// AUDITOR_LENS 已经内嵌进每条 prompt(原 PROBE_SYSTEM / FINALIZE_SYSTEM 取消)。

// PROBE_SCHEMA 留作"主 Claude 应当产出的形状"的口头契约 — 没有 schema enforcement
// 了(主 Claude 不走 --json-schema),但 prompt 里会要求严格 JSON,实测稳定。
const PROBE_SCHEMA = {
  type: 'object',
  required: ['proposedTitle', 'draftSTAR', 'questions'],
  properties: {
    proposedTitle: { type: 'string' },
    draftSTAR: {
      type: 'object',
      required: ['situation', 'task', 'action', 'result'],
      properties: {
        situation: { type: 'string' },
        task: { type: 'string' },
        action: { type: 'string' },
        result: { type: 'string' },
      },
    },
    questions: {
      // 固定 4 道,按 S/T/A/R 各一,顺序由 prompt 约束(JSON Schema 表达不了"分别命中每个 enum 值")。
      // slash command 会把这 4 道压到同一次 AskUserQuestion 调用 — API 上限刚好 4 题。
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: {
        type: 'object',
        required: ['module', 'prompt', 'options'],
        properties: {
          module: { enum: ['S', 'T', 'A', 'R'] },
          prompt: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

function buildProbePrompt({ rangeLabel, evidencePack }) {
  return `${AUDITOR_LENS}

你现在是初稿阶段。基于下面的证据包,做两件事:

A) 用现有证据填一份 STAR 初稿(四段)。证据不足以判断的地方,该段写一句 "[需采访:具体缺什么]"。
B) 出**正好 4 道**采访题,**按 S→T→A→R 顺序各一道**(slash command 会把这 4 道压到同一个 AskUserQuestion 调用,一屏勾完)。
   每道问 LLM 看不出来的事:作者的动机、当时的痛点强度、被淘汰的备选方案、真实 ROI、下次能复用到哪里、有没有走过弯路。

**叙事对象是"事件",不是"会话"**:证据包很可能包含多个 sessionId(同一件事跨了好几次对话),
也会带 \`gitDiff\` / \`keyArtifacts\` / \`sessionTimeline\` 这些跨会话的产物证据。
你要把整件事当一个事件叙述 — 不要按 session 拆段、不要复述 jsonl 里的对话流水,
**优先看 git commit 改了什么、artifact 长什么样**(产物是最强证据,对话只是过程注脚)。
单 session 也用同样写法(只是 sessionTimeline 只有一条而已)。

时间范围:${rangeLabel}

[证据包]
${JSON.stringify(evidencePack, null, 2)}

输出严格 JSON,无 markdown 围栏,无开场白。形状:

{
  "proposedTitle": "案例名(8-20 字,不含日期/期号/案例编号)",
  "draftSTAR": {
    "situation": "60-180 字,作者当时的处境,问题为什么会冒出来",
    "task":      "60-180 字,作者给自己定的目标 + 隐含约束",
    "action":    "60-180 字,关键动作,叙事化,不堆工具名,跳过琐碎实现",
    "result":    "60-180 字,产物 + 量化或诚实'未量化' + 一句点到未来杠杆"
  },
  "questions": [
    { "module": "S", "prompt": "...", "options": ["最佳猜测", "其他角度", "其他角度?"] },
    { "module": "T", "prompt": "...", "options": [...] },
    { "module": "A", "prompt": "...", "options": [...] },
    { "module": "R", "prompt": "...", "options": [...] }
  ]
}

要求:
- 4 道题严格按 S→T→A→R 顺序排列,module 字段必须分别是 "S","T","A","R"。
- 每道题 options 2-3 个;第一个是基于证据的最佳猜测(用户直接点 = 静默接受),其余是其他合理角度。
- 不要问 LLM 自己能从证据包推出来的事。专问动机、痛点、备选、真实 ROI、复用面、弯路。
- 用户秒懂的口语化中文。`;
}

function buildFinalizePrompt({ rangeLabel, evidencePack, drafts, answers, hasMultipleCases, bannedHits }) {
  const answersBlock = answers
    .map((a, i) => `Q${i + 1} (${a.module}): ${a.prompt}\nA: ${a.answer || '(用户未明确)'}`)
    .join('\n\n');

  const rewriteNote = (bannedHits && bannedHits.length > 0)
    ? `\n\n[重写要求]\n上一次产出命中了禁用短语:${bannedHits.join('、')}。请用同样的事实重写,改用平实白话,绕开这些短语。`
    : '';

  return `${AUDITOR_LENS}

时间范围:${rangeLabel}
案例数:${hasMultipleCases ? '多案例' : '单案例'}

**叙事对象是"事件",不是"会话"**:每条证据包可能涵盖多个 sessionId 和 commit,
\`gitDiff\` / \`keyArtifacts\` / \`sessionTimeline\` 是一等公民证据。
重点写"这件事最终改了什么 / 留下什么 artifact",而不是"在第 N 次会话里说了什么"。
对话内容(jsonlHead/Tail)只作为动机和过程的旁证,不要复述。

[证据包]
${JSON.stringify(evidencePack, null, 2)}

[STAR 初稿]
${JSON.stringify(drafts, null, 2)}

[用户采访答复]
${answersBlock}

请融合初稿和用户答复,写出最终 markdown。规则:

结构:
${
  hasMultipleCases
    ? '- 顶部 H1 用期号(如 "# AI 最佳实践 — 2026-W20"),每个案例 H2 用案例名'
    : '- H1 直接用案例名(如 "# 会话评分流水线工程化"),不要 H2 副标题,不要 "## 案例 1" 这种'
}
- STAR 四段每段一个 H3 或加粗小标题:**背景**、**目标**、**做了什么**、**结果与杠杆**
- 段落主体写散文,不要 bullet 堆叠实现细节。如果一定要列,限 1 处、每处 ≤ 4 条。
- 文末单独一段引用块:> 涵盖会话:<sessionId 列表,逗号分隔> 起止时间:... 主要 commit:<前 3 条 hash> 主要产物:<前 3 个文件路径>
- 整体 700-1200 字。

写作:
- 用户没回答的问题,对应模块的相关段落直接写"本次未明确"或留白,不要瞎编。
- 不堆工具名清单,如果非提不可就用一句话带过("以 Claude Code 的 hook + slash command 协作")。
- 不要这些 LLM 套路短语:${BANNED_PHRASES.join('、')}。
- 不要 emoji,不要独立的 --- 分隔线,不要 "首先...其次...最后" 的总分总骨架。
- 直接输出 markdown 正文,不要 \`\`\` 围栏,不要任何前言或解释。${rewriteNote}`;
}

module.exports = {
  AUDITOR_LENS,
  BANNED_PHRASES,
  PROBE_SCHEMA,
  buildProbePrompt,
  buildFinalizePrompt,
  detectBanned,
  titleToSlug,
  extractTitle,
};

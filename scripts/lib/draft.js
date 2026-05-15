// 周报起草:两阶段 + 一轮采访。
//   proposeAndProbe(evidencePack)  → 出初稿 + 采访问题清单(LLM 看不出的信息)
//   <commands 层调 AskUserQuestion 收集答案>
//   finalize({evidencePack, drafts, answers}) → 最终 markdown,自动过滤 LLM 废话
//
// 假想敌:公司内部的"AI 最佳实践审计 AI",它从全公司每周成百上千份提交里挑真金,不奖励"会写报告的人"。
// 见 AUDITOR_LENS。

const { spawn } = require('child_process');

const MODEL = process.env.AIBP_DRAFT_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_MS = Number(process.env.AIBP_DRAFT_TIMEOUT_MS || 240_000);

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

// ===== 阶段 1:proposeAndProbe =====

const PROBE_SYSTEM = `${AUDITOR_LENS}

你现在是初稿阶段。读完证据包后,你要做两件事:

A) 用现有证据填一份 STAR 初稿(四段)。证据不足以判断的地方,该段写一句 "[需采访:具体缺什么]"。
B) 列出 3-5 个采访问题,问 LLM 看不出来的事:作者的动机、当时的痛点强度、被淘汰的备选方案、真实 ROI、下次能复用到哪里、有没有走过弯路。

输出严格 JSON,无 markdown 围栏,无开场白。`;

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
      type: 'array',
      minItems: 3,
      maxItems: 5,
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
  return `时间范围:${rangeLabel}

[证据包]
${JSON.stringify(evidencePack, null, 2)}

要求:
1. proposedTitle 是具体案例名(8-20 字),不含日期/期号/案例编号。例:"会话评分流水线工程化"。
2. draftSTAR 四段:
   - situation:作者当时的处境,问题为什么会冒出来。
   - task:作者给自己定的目标,以及隐含的约束。
   - action:做了什么,只写关键动作,跳过琐碎实现。叙事化,不堆工具名。
   - result:产物 + 量化或诚实"未量化" + 一句话点到未来杠杆。
   每段 60-180 字。证据不足以判断的地方留 [需采访:...]。
3. questions 3-5 道。每道:
   - module: S/T/A/R 任一
   - prompt: 用户能秒懂的问题,口语化,中文。
   - options: 2-3 个候选答案,第一个是你基于证据的最佳猜测(用户直接点 = 静默接受),其余是其他合理角度。
   不要问 LLM 自己能从证据包推出来的事。专问动机、痛点、备选、真实 ROI、复用面、弯路。`;
}

async function proposeAndProbe({ rangeLabel, evidencePack }) {
  const prompt = buildProbePrompt({ rangeLabel, evidencePack });
  const out = await runClaude({
    prompt,
    system: PROBE_SYSTEM,
    jsonSchema: PROBE_SCHEMA,
  });
  const parsed = JSON.parse(out.result);
  return { ...parsed, cost: out.cost };
}

// ===== 阶段 2:finalize =====

function buildFinalizePrompt({ rangeLabel, evidencePack, drafts, answers, hasMultipleCases }) {
  const answersBlock = answers
    .map((a, i) => `Q${i + 1} (${a.module}): ${a.prompt}\nA: ${a.answer || '(用户未明确)'}`)
    .join('\n\n');

  return `时间范围:${rangeLabel}
案例数:${hasMultipleCases ? '多案例' : '单案例'}

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
- 文末单独一段引用块:> sessionId:... 起止时间:... 主要产物路径:...
- 整体 700-1200 字。

写作:
- 用户没回答的问题,对应模块的相关段落直接写"本次未明确"或留白,不要瞎编。
- 不堆工具名清单,如果非提不可就用一句话带过("以 Claude Code 的 hook + slash command 协作")。
- 不要这些 LLM 套路短语:${BANNED_PHRASES.join('、')}。
- 不要 emoji,不要独立的 --- 分隔线,不要 "首先...其次...最后" 的总分总骨架。
- 直接输出 markdown 正文,不要 \`\`\` 围栏,不要任何前言或解释。`;
}

const FINALIZE_SYSTEM = AUDITOR_LENS;

async function finalize({ rangeLabel, evidencePack, drafts, answers, hasMultipleCases }) {
  const prompt = buildFinalizePrompt({ rangeLabel, evidencePack, drafts, answers, hasMultipleCases });
  const first = await runClaude({ prompt, system: FINALIZE_SYSTEM });
  const hits = detectBanned(first.result);
  if (hits.length === 0) {
    return {
      markdown: first.result,
      title: extractTitle(first.result),
      cost: first.cost,
      retried: false,
    };
  }
  // 触发一次重写。继续命中就接受现状,不再无限循环。
  const retryPrompt = `${prompt}

[重写要求]
上一次产出命中了禁用短语:${hits.join('、')}。请用同样的事实重写,改用平实白话,绕开这些短语。直接输出新版 markdown。`;
  const second = await runClaude({ prompt: retryPrompt, system: FINALIZE_SYSTEM });
  return {
    markdown: second.result,
    title: extractTitle(second.result),
    cost: (first.cost || 0) + (second.cost || 0),
    retried: true,
  };
}

function extractTitle(markdown) {
  const m = /^#\s+(.+)$/m.exec(markdown || '');
  return m ? m[1].trim() : 'untitled';
}

// ===== claude -p 子进程封装 =====

function runClaude({ prompt, system, jsonSchema }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--bare',
      '--no-session-persistence',
      '--permission-mode', 'bypassPermissions',
      '--model', MODEL,
      '--output-format', 'json',
      '--append-system-prompt', system,
    ];
    if (jsonSchema) {
      args.push('--json-schema', JSON.stringify(jsonSchema));
    }
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exit ${code}: ${stderr.slice(0, 500)}`));
      let outer;
      try { outer = JSON.parse(stdout); }
      catch (e) { return reject(new Error(`claude -p output not JSON: ${stdout.slice(0, 300)}`)); }
      if (outer.is_error) return reject(new Error(`claude error: ${outer.result || outer.error}`));
      resolve({
        result: jsonSchema ? JSON.stringify(outer.structured_output) : (outer.result || ''),
        cost: outer.total_cost_usd,
      });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = {
  proposeAndProbe,
  finalize,
  titleToSlug,
  detectBanned,
  extractTitle,
  buildProbePrompt,
  buildFinalizePrompt,
  AUDITOR_LENS,
  BANNED_PHRASES,
  PROBE_SCHEMA,
  MODEL,
};

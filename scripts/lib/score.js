// 用 claude -p 调 Haiku 4.5,对会话卡片做含金量评分。
// 输入:parse-jsonl.js 产出的 card;输出:{score, summary, highlights, tags}。

const { spawn } = require('child_process');

const MODEL = process.env.AIBP_SCORE_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.AIBP_SCORE_TIMEOUT_MS || 180_000);

const SYSTEM = `你在评估一段 Claude Code 会话作为"AI 最佳实践案例"的含金量。
评分维度:
- 问题复杂度 / AI 替代了多少手工劳动
- 工作流创新度(工具组合 / Skill / MCP / hook / plugin)
- 可复用性(是否产出可沉淀的脚本/skill/hook/PR)
- 故事完整度(问题 → 方法 → 结果)
低分情形:闲聊、单轮简单问答、纯重复劳动、纯报错排查无沉淀。

只输出一个严格 JSON 对象,无其他文字、无 markdown 围栏。`;

function buildUserPrompt(card) {
  const compact = {
    cwd: card.cwd,
    startedAt: card.startedAt,
    endedAt: card.endedAt,
    turns: card.turns,
    firstPrompt: card.firstPrompt,
    lastUserPrompt: card.lastUserPrompt,
    tools: card.tools,
    skills: card.skills,
    mcpServers: card.mcpServers,
    filesEditedCount: (card.filesEdited || []).length,
    filesEditedSample: (card.filesEdited || []).slice(0, 8),
    keyTurns: card.keyTurns,
  };
  return `请为下面这段 Claude Code 会话打分。

[会话卡片 JSON]
${JSON.stringify(compact, null, 2)}

请只输出一个 JSON 对象,字段:
{
  "score": 0-100 的整数,
  "summary": "1-2 句中文摘要,讲清楚做了什么、产出了什么",
  "highlights": ["亮点 1", "亮点 2"],         // 0-3 条,中文短句
  "tags": ["automation"|"refactor"|"debug"|"meta"|"integration"|"design"|"docs"|"infra"|"data"|"learning"|"chat"]
}

注意:
- 闲聊/打招呼/单轮问答 ≤ 30 分
- 走完了 plan → 实现 → 验证流程,且产出代码/脚本/skill/hook 的 ≥ 70 分
- 跨工具组合(MCP/Skill/Bash 协作)+10
- 产出可分发的 plugin / 通用工具 +10`;
}

const SCORE_SCHEMA = {
  type: 'object',
  required: ['score', 'summary', 'highlights', 'tags'],
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    highlights: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', maxLength: 200 },
    },
    tags: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', maxLength: 30 },
    },
  },
};

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--bare',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--append-system-prompt',
      SYSTEM,
      '--json-schema',
      JSON.stringify(SCORE_SCHEMA),
    ];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseResult(stdout) {
  const outer = JSON.parse(stdout);
  if (outer.is_error) throw new Error(`claude error: ${outer.result || outer.error}`);
  // 优先用 structured_output(--json-schema 触发),否则回退到 result 文本
  let obj = outer.structured_output;
  if (!obj) {
    let text = (outer.result || '').trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    obj = JSON.parse(text);
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(obj.score))),
    summary: String(obj.summary || '').trim(),
    highlights: Array.isArray(obj.highlights) ? obj.highlights.slice(0, 3) : [],
    tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 6) : [],
    cost: outer.total_cost_usd,
    model: MODEL,
  };
}

async function scoreCard(card) {
  const prompt = buildUserPrompt(card);
  const stdout = await runClaude(prompt);
  return parseResult(stdout);
}

module.exports = { scoreCard, MODEL };

if (require.main === module) {
  const { buildSessionCard } = require('./parse-jsonl');
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node score.js <jsonl-path>');
    process.exit(1);
  }
  (async () => {
    const card = await buildSessionCard(path);
    const res = await scoreCard(card);
    console.log(JSON.stringify({ card: { sessionId: card.sessionId, turns: card.turns }, ...res }, null, 2));
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

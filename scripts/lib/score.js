// 用 claude -p 调 Haiku 4.5,对会话卡片做含金量评分。
// 输入:parse-jsonl.js 产出的 card;输出:{score, summary, highlights, tags}。

const { spawn } = require('child_process');

const MODEL = process.env.AIBP_SCORE_MODEL || 'claude-haiku-4-5';
// 0.1.45:180s → 60s。配合 --system-prompt 替换 + --disallowed-tools "*",
// Haiku 不再在工具上反复思考,输出从 ~5K tokens 降到 ~2.5K,墙钟从 ~45s 降到 ~25s,
// 60s 上限足够覆盖正常波动。撞 60s 的 case 大概率是卡片本身太大触发了无穷输出,
// retry 也没用 — scoreCard 里已经把 timeout 排除出 retry 分支。
const TIMEOUT_MS = Number(process.env.AIBP_SCORE_TIMEOUT_MS || 60_000);

const SYSTEM = `你在评估一段 Claude Code 会话作为"AI 最佳实践案例"的含金量。
评分维度:问题复杂度 / 工作流创新度(工具组合 / Skill / MCP / hook / plugin)/ 可复用性(是否产出可沉淀的脚本/skill/hook/PR)/ 故事完整度(问题 → 方法 → 结果)。
低分情形:闲聊、单轮简单问答、纯重复劳动、纯报错排查无沉淀。

输出一个 JSON 对象(schema 已强制约束),不要任何 markdown 或前导文字。`;

function buildUserPrompt(card) {
  const commits = card.gitCommitsInWindow || [];
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
    gitCommitsInWindowCount: commits.length,
    gitCommitsInWindowSample: commits.slice(0, 10),
    keyTurns: card.keyTurns,
  };
  return `请为下面这段 Claude Code 会话打分。

[会话卡片 JSON]
${JSON.stringify(compact)}

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
- 产出可分发的 plugin / 通用工具 +10
- gitCommitsInWindowCount > 0 是强证据 +15
- 无 commit 不单独扣分。文档 / 配置 / dotfile / skill / 个人脚本 / prompt 模板这类产出本来就不进 git,看 filesEditedSample 类型自己判;只有"代码扩展名 + 在 git 仓库内 + 零 commit"才是警惕信号`;
}

// tags 的合法取值集合,和 buildUserPrompt 里 prompt 列出的一致。
// 0.1.41 前不带 enum,Haiku 偶尔会自造("optimization"/"workflow"/"security"/"seo"),
// 全量 932 个 tag 实例里漂了 5 个,虽然不多但污染 --tag 过滤(用户用规范名字找不到)。
// 加 enum 后 schema-constrained 输出直接被拒,Haiku 自然回退到 whitelist。
const TAG_ENUM = [
  'automation',
  'refactor',
  'debug',
  'meta',
  'integration',
  'design',
  'docs',
  'infra',
  'data',
  'learning',
  'chat',
];

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
      items: { type: 'string', enum: TAG_ENUM },
    },
  },
};

// 标记 timeout 错误,scoreCard 据此跳过 retry。timeout 是确定性的(同 prompt 必然再超),
// retry 只会浪费 2× 时间。0.1.45 之前 retry timeout 是把 60→120s 的元凶。
class TimeoutError extends Error {
  constructor(msg) { super(msg); this.code = 'TIMEOUT'; }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    // 0.1.45 关键改动:`--system-prompt` 整体替换默认 agentic system prompt(原本是
    // append),配合 `--disallowed-tools "*"` 不让 Haiku 看到任何工具。实测包袱从 24K
    // 降到 12K,output 从 5K 降到 2.5K,cost -36% / 墙钟 -42%。详见 0.1.45 commit。
    const args = [
      '-p',
      '--bare',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--disallowed-tools',
      '*',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--system-prompt',
      SYSTEM,
      '--json-schema',
      JSON.stringify(SCORE_SCHEMA),
    ];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TimeoutError(`claude -p timeout after ${TIMEOUT_MS}ms`));
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
    tags: filterTags(obj.tags),
    cost: outer.total_cost_usd,
    model: MODEL,
  };
}

async function scoreCard(card) {
  // 一次重试:覆盖网络抖动 / Anthropic 偶发 502 这类瞬时错。
  // 0.1.45:timeout 不再 retry — 同 prompt 必然再超,retry 只浪费 2× 时间。
  // 还失败就丢给调用方记 error,后续 scan 会按 #5 失败缓存策略处理。
  const prompt = buildUserPrompt(card);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stdout = await runClaude(prompt);
      return parseResult(stdout);
    } catch (err) {
      lastErr = err;
      if (err.code === 'TIMEOUT') throw err; // timeout 直接抛,不进 retry
      // 第二次重试前小退避 1-2s,避免抖动期再撞同一波。
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }
  throw lastErr;
}

// 解析侧也补一道防线:即便 schema 没强 enum(老 Claude CLI / 切到无 schema 模型时),
// parseResult 会把 off-whitelist 的 tag 静默丢掉,保证写入索引的 tags 干净。
function filterTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    if (!TAG_ENUM.includes(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, 6);
}

module.exports = {
  scoreCard,
  MODEL,
  buildUserPrompt,
  parseResult,
  SCORE_SCHEMA,
  SYSTEM,
  TAG_ENUM,
  filterTags,
  TimeoutError,
};

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

// 把选中的 case 详情送给 claude -p 起草中文 markdown。
// 输入:cases 数组(每个元素含 summary/highlights/tags + 抽取的关键片段),
// 输出:完整的 markdown 文本(由调用方写入文件)。

const { spawn } = require('child_process');

const MODEL = process.env.AIBP_DRAFT_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_MS = Number(process.env.AIBP_DRAFT_TIMEOUT_MS || 240_000);

const SYSTEM = `你正在为公司 OKR 撰写"AI 最佳实践周报"。
读者是公司 AI 评审委员,会按"案例含金量、复用价值、表达清晰度"打分。
要求:
- 中文,平实可信,避免空话和形容词堆砌
- 每个案例突出"问题 → 用 AI 怎么做 → 沉淀产物 → 量化收益"
- 量化收益没有就老实写"未量化",不要编造数字
- 引用具体命令、文件、PR、sessionId,展示真实性
- 所有案例总长 800-1500 字`;

function buildPrompt({ rangeLabel, cases }) {
  return `请基于下面的会话素材,生成一份本期 AI 最佳实践周报的 markdown 草稿。

时间范围:${rangeLabel}
案例数:${cases.length}

[案例素材 JSON]
${JSON.stringify(cases, null, 2)}

输出要求:
- 顶部标题:# AI 最佳实践 — ${rangeLabel}
- 每个案例一节:## 案例 N:<简短标题(不超过 20 字)>
- 每节固定结构:
  **场景**:1-2 句
  **用 AI 做了什么**:具体动作,提到关键工具/skill/MCP/hook
  **关键工作流 / Prompt**:可贴 1-2 个关键 prompt 或命令(代码块)
  **沉淀产物**:列出脚本/skill/hook/PR 的相对路径(若有)
  **量化收益**:有就写,没有就写"未量化"
  **会话引用**:sessionId / 起止时间(从素材里取)
- 文末加一行:"> 本草稿由 /ai-practice-pick 自动生成,人工调整后提交。"

直接输出 markdown,不要 \`\`\` 围栏,不要前言。`;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--bare',
      '--no-session-persistence',
      '--permission-mode', 'bypassPermissions',
      '--model', MODEL,
      '--output-format', 'json',
      '--append-system-prompt', SYSTEM,
    ];
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
      resolve(stdout);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function draft({ rangeLabel, cases }) {
  const prompt = buildPrompt({ rangeLabel, cases });
  const stdout = await runClaude(prompt);
  const outer = JSON.parse(stdout);
  if (outer.is_error) throw new Error(`claude error: ${outer.result || outer.error}`);
  return { markdown: outer.result || '', cost: outer.total_cost_usd, model: MODEL };
}

module.exports = { draft, MODEL };

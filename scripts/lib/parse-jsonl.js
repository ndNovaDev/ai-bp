// 把 Claude Code 会话 jsonl 文件压成"会话卡片",供 score.js 使用。
// 卡片目标 ≤ ~2K token,只保留判断含金量需要的信息。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const KEY_TURN_MIN_USER_CHARS = 80;
const KEY_TURN_MIN_TOOLS = 3;
const KEY_TURN_TEXT_CAP = 400;
const MAX_KEY_TURNS = 5;

// 0.1.45:大 jsonl 激进压。>1MB 文件出来的 keyTurns 会肥到把 Haiku 输出顶爆 5K tokens,
// 触发 60s 墙(0.1.45 之前的 100+ 个 180s timeout 几乎全是这类文件)。
// 实测把上限砍半 + 单条文本砍到 1/3,prompt 从 ~3K 降到 ~1.5K,Haiku output 顺势降一半,
// 评分质量在 spot-check 上没明显损失(本来这种"聊很久"会话也评不到 gold)。
const LARGE_JSONL_THRESHOLD = 1_000_000;
const LARGE_MAX_KEY_TURNS = 2;
const LARGE_KEY_TURN_TEXT_CAP = 150;

// Claude Code 框架在 user 消息里塞的 XML 包装块,不是用户人话:
// /clear 之类的 slash command 会被记成 <command-name>/clear</command-name>;
// `!` bash 触发会拿 <bash-input>/<bash-stdout>/<bash-stderr>; 还有 <system-reminder>
// / <local-command-stdout> / <user-prompt-submit-hook> / <ide_selection>。
// 实测全量 jsonl 里 20% 的 user turn 含这些,且 97% 是去掉之后就空了 ——
// 它们污染 (a) 起草阶段 extractUserTurns 锚定的"用户原话",(b) Haiku 评分卡里
// firstPrompt / lastUserPrompt / keyTurns。
// 这里把这些标签连同内容一起剥掉。普通 XML/HTML 不在白名单内,不会误伤。
const NOISE_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'system-reminder',
  'user-prompt-submit-hook',
  'ide_selection',
];
// 每个 tag 独立一条 regex,确保开闭配对(不会跨 tag 错配吃半截)。
// 开标签允许可选属性。非贪婪 + 不动点循环,把嵌套场景也清干净。
const NOISE_RE_LIST = NOISE_TAGS.map(
  (t) => new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, 'g'),
);

function stripFrameworkNoise(text) {
  if (!text) return '';
  let s = String(text);
  for (let i = 0; i < 5; i++) {
    const before = s;
    for (const re of NOISE_RE_LIST) s = s.replace(re, '');
    if (s === before) break;
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

function toolUsesOfContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'tool_use');
}

function clip(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 在 session 的时间窗口内,对 cwd 跑 git log,拿到这段会话期间产生的 commit。
// 这是"AI 产出真的落地了"的最强证据,比 filesEdited 计数靠谱得多。
// best-effort:cwd 不是 git 仓库 / git 不可用 / 超时,一律返回 [],不抛错。
async function gitCommitsInWindow(cwd, startedAt, endedAt) {
  if (!cwd || !startedAt) return [];
  try {
    if (!fs.existsSync(path.join(cwd, '.git'))) return [];
  } catch {
    return [];
  }
  const until = endedAt || new Date().toISOString();
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'log', '--oneline', `--since=${startedAt}`, `--until=${until}`, '-n', '20'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 },
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function buildSessionCard(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sessionId = null;
  let cwd = null;
  let startedAt = null;
  let endedAt = null;
  let turns = 0;
  let firstPrompt = null;
  let lastUserPrompt = null;
  const tools = {};
  const skills = new Set();
  const mcpServers = new Set();
  const filesEdited = new Set();

  // 我们 streaming 时不能一次性 lookback,因此先收集"事件",最后再挑 key turns
  const events = []; // {role, text, toolUses:[{name}], ts}

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (entry.timestamp) {
      if (!startedAt) startedAt = entry.timestamp;
      endedAt = entry.timestamp;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role || entry.type;
    let text = textOfContent(msg.content);
    const toolUses = toolUsesOfContent(msg.content);

    // 过滤纯 tool_result 的 user 消息(那是工具回执,不是真的用户输入)
    if (role === 'user') {
      const hasToolResult =
        Array.isArray(msg.content) && msg.content.some((p) => p && p.type === 'tool_result');
      // 剥掉 Claude Code 框架的 XML 包装块(slash command / bash / system-reminder 等)。
      // 整条 strip 后为空 → 这个 turn 根本不是人话,跳过(不计 turn、不进 keyTurns)。
      text = stripFrameworkNoise(text);
      const hasText = text.length > 0;
      if (hasToolResult && !hasText) continue;
      if (!hasText && !toolUses.length) continue;
      if (hasText) {
        turns++;
        if (!firstPrompt) firstPrompt = text;
        lastUserPrompt = text;
      }
    }

    // 工具统计
    for (const tu of toolUses) {
      const name = tu.name || 'unknown';
      tools[name] = (tools[name] || 0) + 1;
      const input = tu.input || {};
      if (name === 'Skill' && input.skill) skills.add(input.skill);
      if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
        if (input.file_path) filesEdited.add(input.file_path);
      }
      // MCP 工具命名通常是 mcp__<server>__<method>
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        if (parts[1]) mcpServers.add(parts[1]);
      }
    }

    events.push({ role, text, toolUses: toolUses.map((t) => t.name), ts: entry.timestamp });
  }

  // 大 jsonl 走更狠的压缩档位(见上方常量注释)
  const isLarge = stat.size >= LARGE_JSONL_THRESHOLD;
  const maxKeyTurns = isLarge ? LARGE_MAX_KEY_TURNS : MAX_KEY_TURNS;
  const textCap = isLarge ? LARGE_KEY_TURN_TEXT_CAP : KEY_TURN_TEXT_CAP;

  // 挑 keyTurns:用户消息 ≥ 80 字 / assistant 伴随 ≥ 3 工具
  const candidates = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.role === 'user' && ev.text.length >= KEY_TURN_MIN_USER_CHARS) {
      candidates.push({ idx: i, score: ev.text.length });
    } else if (ev.role === 'assistant' && ev.toolUses.length >= KEY_TURN_MIN_TOOLS) {
      candidates.push({ idx: i, score: ev.toolUses.length * 30 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = candidates.slice(0, maxKeyTurns).sort((a, b) => a.idx - b.idx);
  const keyTurns = picked.map(({ idx }) => {
    const ev = events[idx];
    return {
      role: ev.role,
      text: clip(ev.text, textCap),
      tools: ev.toolUses,
    };
  });

  const commits = await gitCommitsInWindow(cwd, startedAt, endedAt);

  return {
    sessionId,
    cwd,
    startedAt,
    endedAt,
    turns,
    firstPrompt: clip(firstPrompt || '', 500),
    lastUserPrompt: clip(lastUserPrompt || '', 300),
    tools,
    skills: [...skills],
    mcpServers: [...mcpServers],
    filesEdited: [...filesEdited].slice(0, 20),
    gitCommitsInWindow: commits,
    keyTurns,
    jsonlPath,
    jsonlMtime: Math.floor(stat.mtimeMs / 1000),
  };
}

// 起草阶段用:流式抽出 session 里所有真实的 user text 消息(过滤 tool_result 回执),
// 按时间顺序返回 [{ts, text}]。这是周报起草的主证据 —— 用户的真实意图 / 卡点 / 转折,
// 唯一没被 Haiku 摘要过滤掉的"人话"。assistant 输出不抽,那部分已经在 git 里物化了。
async function extractUserTurns(jsonlPath, opts = {}) {
  const { maxCharsPerTurn = 0 } = opts; // 0 = 不截断
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const turns = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const msg = entry.message;
    if (!msg) continue;
    const raw = textOfContent(msg.content);
    if (!raw) continue; // 纯 tool_result(无文本)跳过
    // 剥掉 Claude Code 框架的 XML 包装块。这是起草锚定的主证据 ——
    // 让 <command-name>/clear</command-name> 这类 bookkeeping 进文章会拉低质量。
    const text = stripFrameworkNoise(raw);
    if (!text) continue;
    turns.push({
      ts: entry.timestamp || null,
      text: maxCharsPerTurn > 0 ? clip(text, maxCharsPerTurn) : text,
    });
  }
  return turns;
}

module.exports = { buildSessionCard, gitCommitsInWindow, extractUserTurns, stripFrameworkNoise };

if (require.main === module) {
  const args = process.argv.slice(2);
  // CLI:`node parse-jsonl.js --user-turns <jsonl>` 输出文本块给主对话直读
  if (args[0] === '--user-turns') {
    const jsonlPath = args[1];
    if (!jsonlPath) {
      console.error('Usage: node parse-jsonl.js --user-turns <jsonl-path> [--max-chars N]');
      process.exit(1);
    }
    const maxIdx = args.indexOf('--max-chars');
    const maxCharsPerTurn = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) || 0 : 0;
    extractUserTurns(jsonlPath, { maxCharsPerTurn }).then(
      (turns) => {
        for (const t of turns) {
          process.stdout.write(`[${t.ts || '?'}]\n${t.text}\n---\n`);
        }
      },
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
    return;
  }
  const jsonlPath = args[0];
  if (!jsonlPath) {
    console.error('Usage: node parse-jsonl.js <jsonl-path>');
    console.error('       node parse-jsonl.js --user-turns <jsonl-path> [--max-chars N]');
    process.exit(1);
  }
  buildSessionCard(jsonlPath).then(
    (card) => console.log(JSON.stringify(card, null, 2)),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

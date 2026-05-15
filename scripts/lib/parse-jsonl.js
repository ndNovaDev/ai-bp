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
    const text = textOfContent(msg.content);
    const toolUses = toolUsesOfContent(msg.content);

    // 过滤纯 tool_result 的 user 消息(那是工具回执,不是真的用户输入)
    if (role === 'user') {
      const hasToolResult =
        Array.isArray(msg.content) && msg.content.some((p) => p && p.type === 'tool_result');
      const hasText = text.length > 0;
      if (hasToolResult && !hasText) continue;
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
  const picked = candidates.slice(0, MAX_KEY_TURNS).sort((a, b) => a.idx - b.idx);
  const keyTurns = picked.map(({ idx }) => {
    const ev = events[idx];
    return {
      role: ev.role,
      text: clip(ev.text, KEY_TURN_TEXT_CAP),
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

module.exports = { buildSessionCard, gitCommitsInWindow };

if (require.main === module) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node parse-jsonl.js <jsonl-path>');
    process.exit(1);
  }
  buildSessionCard(path).then(
    (card) => console.log(JSON.stringify(card, null, 2)),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

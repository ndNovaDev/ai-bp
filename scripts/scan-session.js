#!/usr/bin/env node
// Stop hook 入口:对单个 jsonl 跑评分流程,与 scan.js 共享 lib。
// 用法:node scan-session.js <jsonl-path>
//
// 失败一律静默(写日志),不影响主对话退出。

const fs = require('fs');
const path = require('path');
const { buildSessionCard } = require('./lib/parse-jsonl');
const { scoreCard } = require('./lib/score');
const { tryHeuristicScore } = require('./lib/heuristic');
const { INDEX_PATH, LOG_PATH } = require('./lib/paths');

const EXCLUDE_PREFIXES = [];

function log(msg) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}][hook] ${msg}\n`);
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(INDEX_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.sessionId) map.set(o.sessionId, o);
    } catch {}
  }
  return map;
}

function writeIndex(map) {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  const lines = [...map.values()]
    .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''))
    .map((o) => JSON.stringify(o));
  fs.writeFileSync(INDEX_PATH, lines.join('\n') + (lines.length ? '\n' : ''));
}

function cwdAllowed(cwd) {
  if (!cwd) return false;
  return !EXCLUDE_PREFIXES.some((p) => cwd === p || cwd.startsWith(p + '/'));
}

async function main() {
  const jsonlPath = process.argv[2];
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    log(`bad arg: ${jsonlPath}`);
    return;
  }
  const card = await buildSessionCard(jsonlPath);
  if (!card.sessionId) return log(`no session id: ${jsonlPath}`);
  if (!cwdAllowed(card.cwd)) return log(`excluded cwd=${card.cwd}`);
  if (card.turns < 2) return log(`too short sessionId=${card.sessionId} turns=${card.turns}`);

  const indexMap = loadIndex();
  const existing = indexMap.get(card.sessionId);
  if (existing && existing.jsonlMtime === card.jsonlMtime) {
    return log(`cached ${card.sessionId}`);
  }

  // 先走启发式预筛,显然低值的会话不调用 Haiku。详见 lib/heuristic.js。
  const heuristic = tryHeuristicScore(card);
  const scored = heuristic || (await scoreCard(card));
  indexMap.set(card.sessionId, {
    sessionId: card.sessionId,
    cwd: card.cwd,
    startedAt: card.startedAt,
    endedAt: card.endedAt,
    turns: card.turns,
    firstPrompt: card.firstPrompt,
    tools: card.tools,
    skills: card.skills,
    mcpServers: card.mcpServers,
    filesEdited: card.filesEdited,
    gitCommitsInWindow: card.gitCommitsInWindow || [],
    jsonlPath: card.jsonlPath,
    jsonlMtime: card.jsonlMtime,
    model: scored.model,
    score: scored.score,
    summary: scored.summary,
    highlights: scored.highlights,
    tags: scored.tags,
    cost: scored.cost,
    scoredAt: new Date().toISOString(),
  });
  writeIndex(indexMap);
  const tag = heuristic ? 'heuristic' : 'haiku';
  log(`indexed ${card.sessionId} via=${tag} score=${scored.score} cost=$${(scored.cost||0).toFixed(4)}`);
}

main().catch((err) => {
  log(`error: ${err.stack || err.message}`);
  // 静默退出
});

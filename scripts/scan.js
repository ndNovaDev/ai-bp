#!/usr/bin/env node
// 全量/增量扫描:遍历 ~/.claude/projects/ 下 cwd 命中 tyc 或 .claude 的会话,
// 调 lib/score.js 打分,把结果写入 data/index.jsonl(以 sessionId 为主键)。
//
// 用法:
//   node scan.js                # 增量(jsonlMtime 未变跳过)
//   node scan.js --full         # 全量,忽略缓存
//   node scan.js --limit 10     # 只扫前 N 条(按 mtime 倒序)
//   node scan.js --since 2026-05-01

const fs = require('fs');
const path = require('path');
const { buildSessionCard } = require('./lib/parse-jsonl');
const { scoreCard } = require('./lib/score');

const PROJECTS_ROOT = path.join(process.env.HOME, '.claude/projects');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(PLUGIN_ROOT, 'data/index.jsonl');
const LOG_PATH = path.join(process.env.HOME, '.claude/logs/ai-best-practice.log');
const CONCURRENCY = Number(process.env.AIBP_CONCURRENCY || 4);

// 不限 cwd 范围:全部会话都纳入候选,由 Haiku 评分自己淘汰低含金量。
// 如果以后要排除某些目录,在这里加 EXCLUDE_PREFIXES。
const EXCLUDE_PREFIXES = [];

function parseArgs(argv) {
  const args = { full: false, limit: 0, since: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--since') args.since = argv[++i];
  }
  return args;
}

function log(msg) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
}

function listJsonlFiles() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_ROOT, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      files.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return new Map();
  const map = new Map();
  const lines = fs.readFileSync(INDEX_PATH, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId) map.set(obj.sessionId, obj);
    } catch {
      /* skip malformed */
    }
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

async function processOne(jsonlPath, indexMap, force) {
  let card;
  try {
    card = await buildSessionCard(jsonlPath);
  } catch (err) {
    log(`parse failed ${jsonlPath}: ${err.message}`);
    return { status: 'error', reason: 'parse' };
  }
  if (!card.sessionId) return { status: 'skipped', reason: 'no-session-id' };
  if (!cwdAllowed(card.cwd)) return { status: 'skipped', reason: 'cwd-excluded' };
  if (card.turns < 2) return { status: 'skipped', reason: 'too-short' };

  const existing = indexMap.get(card.sessionId);
  if (!force && existing && existing.jsonlMtime === card.jsonlMtime) {
    return { status: 'cached' };
  }

  let scored;
  try {
    scored = await scoreCard(card);
  } catch (err) {
    log(`score failed ${jsonlPath}: ${err.message}`);
    return { status: 'error', reason: 'score' };
  }

  const row = {
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
    jsonlPath: card.jsonlPath,
    jsonlMtime: card.jsonlMtime,
    model: scored.model,
    score: scored.score,
    summary: scored.summary,
    highlights: scored.highlights,
    tags: scored.tags,
    cost: scored.cost,
    scoredAt: new Date().toISOString(),
  };
  indexMap.set(card.sessionId, row);
  return { status: 'ok', score: scored.score, cost: scored.cost };
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  async function next() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  let files = listJsonlFiles();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新的优先

  if (args.since) {
    const t = Date.parse(args.since);
    if (Number.isFinite(t)) files = files.filter((f) => f.mtimeMs >= t);
  }
  if (args.limit > 0) files = files.slice(0, args.limit);

  const indexMap = loadIndex();
  const writeEvery = 5;
  const stats = { total: files.length, ok: 0, cached: 0, skipped: 0, error: 0, cost: 0 };
  let processed = 0;

  console.log(`[scan] candidates=${files.length} concurrency=${CONCURRENCY} full=${args.full}`);

  await runPool(
    files,
    async (f) => {
      const res = await processOne(f.path, indexMap, args.full);
      processed++;
      if (res.status === 'ok') {
        stats.ok++;
        stats.cost += res.cost || 0;
        console.log(`[${processed}/${stats.total}] ok score=${res.score} cost=$${(res.cost||0).toFixed(4)} ${f.path.split('/').pop()}`);
      } else if (res.status === 'cached') {
        stats.cached++;
      } else if (res.status === 'skipped') {
        stats.skipped++;
      } else {
        stats.error++;
        console.log(`[${processed}/${stats.total}] error ${res.reason} ${f.path.split('/').pop()}`);
      }
      if (stats.ok % writeEvery === 0 && res.status === 'ok') {
        writeIndex(indexMap);
      }
    },
    CONCURRENCY,
  );

  writeIndex(indexMap);
  console.log(`[scan] done total=${stats.total} ok=${stats.ok} cached=${stats.cached} skipped=${stats.skipped} error=${stats.error} cost=$${stats.cost.toFixed(2)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    log(`fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

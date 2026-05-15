#!/usr/bin/env node
// 扫描 ~/.claude/projects/ 下所有会话 jsonl,调 lib/score.js 打分,
// 把结果写入 ~/.claude/ai-best-practice/data/index.jsonl(以 sessionId 为主键)。
// 路径可用 AIBP_DATA_DIR 覆盖,详见 lib/paths.js。
//
// 默认就是"全量扫":遍历所有 jsonl,首次跑会评所有 session;
// 之后再跑会跳过 jsonlMtime 未变的(缓存命中,不花钱)。
//
// 用法:
//   node scan.js                  # 全量,带缓存(推荐日常用)
//   node scan.js --rescore        # 强制重评所有(忽略缓存)
//   node scan.js --recent 7d      # 只扫最近 N 天(支持 d/w/m,如 7d / 4w / 1m)
//   node scan.js --since 2026-05-01
//   node scan.js --limit 10       # 只取最新 N 条(主要给调试用)

const fs = require('fs');
const path = require('path');
const { buildSessionCard } = require('./lib/parse-jsonl');
const { scoreCard } = require('./lib/score');
const { tryHeuristicScore } = require('./lib/heuristic');
const { INDEX_PATH, LOG_PATH } = require('./lib/paths');

const PROJECTS_ROOT = path.join(process.env.HOME, '.claude/projects');
// 走 `claude -p` 子进程,每个并发约占 200-500MB 内存。8 在现代 mac 上稳。
// 想再快 / 再省可改 AIBP_CONCURRENCY。
const CONCURRENCY = Number(process.env.AIBP_CONCURRENCY || 8);

// 不限 cwd 范围:全部会话都纳入候选,由 Haiku 评分自己淘汰低含金量。
// 如果以后要排除某些目录,在这里加 EXCLUDE_PREFIXES。
const EXCLUDE_PREFIXES = [];

function parseRecent(expr) {
  // "7d" / "4w" / "1m" / "30" → 返回 cutoff 的 ISO 时间戳
  const m = /^(\d+)\s*([dwm]?)$/i.exec(String(expr || '').trim());
  if (!m) throw new Error(`bad --recent value: ${expr} (use e.g. 7d, 4w, 1m)`);
  const n = Number(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  const days = unit === 'm' ? n * 30 : unit === 'w' ? n * 7 : n;
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function parseArgs(argv) {
  const args = { rescore: false, limit: 0, since: null, countOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rescore' || a === '--force' || a === '--full') args.rescore = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--recent') args.since = parseRecent(argv[++i]);
    else if (a === '--count-only') args.countOnly = true;
  }
  return args;
}

// 把候选 + 已索引 → 拆出 newToScore / alreadyScored / unknown(没记录 jsonlPath 的旧索引)
function classifyCandidates(files, indexMap) {
  // 按 jsonlPath 建反向索引
  const byPath = new Map();
  for (const row of indexMap.values()) {
    if (row.jsonlPath) byPath.set(row.jsonlPath, row);
  }
  let alreadyScored = 0;
  let newToScore = 0;
  for (const f of files) {
    const row = byPath.get(f.path);
    // 索引里有该路径,且 mtime 一致 → 命中缓存,不会重花钱
    if (row && Math.floor(f.mtimeMs / 1000) === row.jsonlMtime) alreadyScored++;
    else newToScore++;
  }
  return { alreadyScored, newToScore };
}

function log(msg) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
}

// `claude -p --no-session-persistence` 仍会在 projects/ 下写一个 1 行 ai-title
// stub(~120 字节)。早过滤,避免下游 parse-jsonl 浪费 IO 又被 turns<2 排除。
// 真实 session 至少 2 轮对话,远超 1KB,所以 < 500 字节一定是元数据 stub。
const STUB_SIZE_THRESHOLD = 500;

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
      if (stat.size < STUB_SIZE_THRESHOLD) continue;
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

  // 启发式预筛:显然低值的会话本地直接打低分,省一次 Haiku 调用。
  // 触发条件见 lib/heuristic.js。
  let scored;
  let attemptsUsed = 0;
  let viaHeuristic = false;
  const h = tryHeuristicScore(card);
  if (h) {
    scored = h;
    viaHeuristic = true;
  } else {
    attemptsUsed = 1;
    try {
      scored = await scoreCard(card, { onAttempt: (n) => { attemptsUsed = n; } });
    } catch (err) {
      log(`score failed ${jsonlPath}: ${err.message}`);
      return { status: 'error', reason: 'score', attemptsUsed };
    }
    if (attemptsUsed > 1) log(`retried ok sessionId=${card.sessionId} attempts=${attemptsUsed}`);
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
  };
  indexMap.set(card.sessionId, row);
  return {
    status: viaHeuristic ? 'heuristic' : 'ok',
    score: scored.score,
    cost: scored.cost,
    attemptsUsed,
  };
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

  if (args.countOnly) {
    // 干跑:只数候选,不打分。slash command 用这个做 preflight 估算。
    const { alreadyScored, newToScore } = classifyCandidates(files, indexMap);
    process.stdout.write(JSON.stringify({
      candidates: files.length,
      alreadyScored,
      newToScore,
      concurrency: CONCURRENCY,
      indexSize: indexMap.size,
    }));
    return;
  }

  const startedAt = Date.now();
  const writeEvery = 5;
  const stats = { total: files.length, ok: 0, cached: 0, skipped: 0, error: 0, heuristic: 0, cost: 0, retried: 0 };
  let processed = 0;

  console.log(`[scan] candidates=${files.length} concurrency=${CONCURRENCY} rescore=${args.rescore}`);

  // 每 10 秒打一次心跳,给前台跑 scan 的人一个进度信号。
  // 没有进度更新就不打(避免空转刷屏)。
  let lastHeartbeatProcessed = -1;
  const heartbeat = setInterval(() => {
    if (processed === lastHeartbeatProcessed) return;
    lastHeartbeatProcessed = processed;
    const elapsed = (Date.now() - startedAt) / 1000;
    const remaining = stats.total - processed;
    // ETA:基于至今平均速度。处理了 0 条就还不知道。
    let eta = '?';
    if (processed > 0 && remaining > 0) {
      const secPerItem = elapsed / processed;
      const etaSec = remaining * secPerItem;
      eta = etaSec >= 60 ? `${(etaSec / 60).toFixed(1)}m` : `${etaSec.toFixed(0)}s`;
    } else if (remaining === 0) {
      eta = '0s';
    }
    console.log(
      `[scan] heartbeat elapsed=${elapsed.toFixed(0)}s | ${processed}/${stats.total} ` +
      `(ok=${stats.ok} heur=${stats.heuristic} cached=${stats.cached} skipped=${stats.skipped} error=${stats.error}` +
      (stats.retried > 0 ? ` retried=${stats.retried}` : '') +
      `) | cost=$${stats.cost.toFixed(2)} | ETA=${eta}`
    );
  }, 10_000);
  heartbeat.unref?.(); // 让进程能正常退出

  await runPool(
    files,
    async (f) => {
      const res = await processOne(f.path, indexMap, args.rescore);
      processed++;
      if (res.status === 'ok') {
        stats.ok++;
        stats.cost += res.cost || 0;
        if (res.attemptsUsed > 1) stats.retried++;
        const retryTag = res.attemptsUsed > 1 ? ` retries=${res.attemptsUsed - 1}` : '';
        console.log(`[${processed}/${stats.total}] ok score=${res.score} cost=$${(res.cost||0).toFixed(4)}${retryTag} ${f.path.split('/').pop()}`);
      } else if (res.status === 'heuristic') {
        stats.heuristic++;
        console.log(`[${processed}/${stats.total}] heur score=${res.score} cost=$0 ${f.path.split('/').pop()}`);
      } else if (res.status === 'cached') {
        stats.cached++;
      } else if (res.status === 'skipped') {
        stats.skipped++;
      } else {
        stats.error++;
        console.log(`[${processed}/${stats.total}] error ${res.reason} ${f.path.split('/').pop()}`);
      }
      // 每 5 条"实打到索引"就持久化一次。heuristic 也算进去 — 否则它们直到 done 才落盘。
      if ((stats.ok + stats.heuristic) % writeEvery === 0 && (res.status === 'ok' || res.status === 'heuristic')) {
        writeIndex(indexMap);
      }
    },
    CONCURRENCY,
  );

  clearInterval(heartbeat);
  writeIndex(indexMap);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const avgCost = stats.ok > 0 ? stats.cost / stats.ok : 0;
  const avgSec = stats.ok > 0 ? elapsedSec / stats.ok : 0;
  console.log(
    `[scan] done total=${stats.total} ok=${stats.ok} heuristic=${stats.heuristic} cached=${stats.cached} skipped=${stats.skipped} error=${stats.error}` +
    (stats.retried > 0 ? ` retried=${stats.retried}` : '') +
    ` cost=$${stats.cost.toFixed(2)} elapsed_sec=${elapsedSec.toFixed(1)} avg_cost=$${avgCost.toFixed(4)} avg_sec=${avgSec.toFixed(2)}`
  );
}

module.exports = { parseArgs, classifyCandidates, listJsonlFiles };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    log(`fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

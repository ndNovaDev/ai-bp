#!/usr/bin/env node
// 读 data/index.jsonl,按过滤条件返回候选 JSON 列表(供 /ai-practice-pick 用)。
//
// 用法:
//   node list.js                                 # 全周期 score>=60 top 30
//   node list.js --since 2026-05-01
//   node list.js --week 2026-W19
//   node list.js --month 2026-05
//   node list.js --tag automation
//   node list.js --top 10 --min-score 70

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(PLUGIN_ROOT, 'data/index.jsonl');

function parseArgs(argv) {
  const a = { since: null, until: null, week: null, month: null, tag: null, top: 30, minScore: 60, full: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--since') a.since = argv[++i];
    else if (k === '--until') a.until = argv[++i];
    else if (k === '--week') a.week = argv[++i];
    else if (k === '--month') a.month = argv[++i];
    else if (k === '--tag') a.tag = argv[++i];
    else if (k === '--top') a.top = Number(argv[++i]);
    else if (k === '--min-score') a.minScore = Number(argv[++i]);
    else if (k === '--full') a.full = true; // 不限 minScore
  }
  return a;
}

function isoWeekRange(weekStr) {
  // 2026-W19 → [Mon 00:00, Mon+7d 00:00) ISO week (Monday start)
  const m = /^(\d{4})-W(\d{1,2})$/.exec(weekStr);
  if (!m) throw new Error(`bad --week format: ${weekStr}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO week 1 = the week containing Jan 4
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7; // 0=Mon
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - dow);
  const start = new Date(week1Mon); start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7);
  return [start.toISOString(), end.toISOString()];
}

function monthRange(monthStr) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(monthStr);
  if (!m) throw new Error(`bad --month: ${monthStr}`);
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  const start = new Date(Date.UTC(y, mo, 1)).toISOString();
  const end = new Date(Date.UTC(y, mo + 1, 1)).toISOString();
  return [start, end];
}

function loadAll() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  const out = [];
  for (const line of fs.readFileSync(INDEX_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  let rows = loadAll();

  let lo = args.since, hi = args.until;
  if (args.week) [lo, hi] = isoWeekRange(args.week);
  else if (args.month) [lo, hi] = monthRange(args.month);

  if (lo) rows = rows.filter((r) => r.endedAt && r.endedAt >= lo);
  if (hi) rows = rows.filter((r) => r.endedAt && r.endedAt < hi);
  if (args.tag) rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(args.tag));
  if (!args.full) rows = rows.filter((r) => (r.score || 0) >= args.minScore);

  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  rows = rows.slice(0, args.top);

  // 输出精简字段(供 LLM 二次排序和 UI 展示用)
  const out = rows.map((r) => ({
    sessionId: r.sessionId,
    date: (r.endedAt || '').slice(0, 10),
    score: r.score,
    summary: r.summary,
    highlights: r.highlights || [],
    tags: r.tags || [],
    cwd: r.cwd,
    turns: r.turns,
    filesEditedCount: (r.filesEdited || []).length,
  }));

  process.stdout.write(JSON.stringify(out, null, 2));
}

if (require.main === module) main();

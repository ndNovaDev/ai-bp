const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isoWeekOf,
  isoWeekRange,
  monthRange,
  parseRecent,
  parseArgs,
  applyFilters,
  toSummary,
} = require('../scripts/list');

// ─── isoWeekOf 跨年/跨月边界 ─────────────────────────────────────────

test('isoWeekOf: Jan 4 always falls into W01 of its year', () => {
  // ISO 8601 定义:1 月 4 日永远在第 1 周
  assert.equal(isoWeekOf(new Date(Date.UTC(2024, 0, 4))), '2024-W01');
  assert.equal(isoWeekOf(new Date(Date.UTC(2025, 0, 4))), '2025-W01');
  assert.equal(isoWeekOf(new Date(Date.UTC(2026, 0, 4))), '2026-W01');
});

test('isoWeekOf: 2026-05-15 (Friday) → 2026-W20', () => {
  assert.equal(isoWeekOf(new Date(Date.UTC(2026, 4, 15))), '2026-W20');
});

test('isoWeekOf: year boundary — 2025-12-29 (Mon) → 2026-W01', () => {
  // 2025-12-29 周一,该周的周四是 2026-01-01,属于 2026 年第 1 周
  assert.equal(isoWeekOf(new Date(Date.UTC(2025, 11, 29))), '2026-W01');
});

test('isoWeekOf: year boundary — 2027-01-01 (Fri) → 2026-W53', () => {
  // 2027-01-01 周五,该周周四是 2026-12-31,属于 2026 年第 53 周
  assert.equal(isoWeekOf(new Date(Date.UTC(2027, 0, 1))), '2026-W53');
});

// ─── isoWeekRange ───────────────────────────────────────────────────

test('isoWeekRange: 2026-W20 → Mon..Mon+7d', () => {
  const [start, end] = isoWeekRange('2026-W20');
  assert.equal(start, '2026-05-11T00:00:00.000Z');
  assert.equal(end, '2026-05-18T00:00:00.000Z');
});

test('isoWeekRange: bad format throws', () => {
  assert.throws(() => isoWeekRange('2026/W20'));
  assert.throws(() => isoWeekRange('W20'));
});

// ─── monthRange ─────────────────────────────────────────────────────

test('monthRange: 2026-05 → May 1 .. June 1 UTC', () => {
  const [start, end] = monthRange('2026-05');
  assert.equal(start, '2026-05-01T00:00:00.000Z');
  assert.equal(end, '2026-06-01T00:00:00.000Z');
});

test('monthRange: handles year wrap (2026-12 → 2027-01-01)', () => {
  const [start, end] = monthRange('2026-12');
  assert.equal(start, '2026-12-01T00:00:00.000Z');
  assert.equal(end, '2027-01-01T00:00:00.000Z');
});

// ─── parseRecent ────────────────────────────────────────────────────

test('parseRecent: 7d, 4w, 1m produce sane ISO timestamps in the past', () => {
  const now = Date.now();
  const d7 = Date.parse(parseRecent('7d'));
  const w4 = Date.parse(parseRecent('4w'));
  const m1 = Date.parse(parseRecent('1m'));
  // 7 天 < 4 周(28 天)< 1 月(我们当 30 天处理)
  assert.ok(now - d7 > 6 * 86400_000 && now - d7 < 8 * 86400_000);
  assert.ok(now - w4 > 27 * 86400_000 && now - w4 < 29 * 86400_000);
  assert.ok(now - m1 > 29 * 86400_000 && now - m1 < 31 * 86400_000);
});

test('parseRecent: bare number defaults to days', () => {
  const t = Date.parse(parseRecent('3'));
  assert.ok(Date.now() - t > 2.9 * 86400_000 && Date.now() - t < 3.1 * 86400_000);
});

test('parseRecent: bad value throws', () => {
  assert.throws(() => parseRecent('abc'));
  assert.throws(() => parseRecent(''));
});

// ─── parseArgs ──────────────────────────────────────────────────────

test('parseArgs: --week sets a.week', () => {
  const a = parseArgs(['node', 'list.js', '--week', '2026-W20']);
  assert.equal(a.week, '2026-W20');
});

test('parseArgs: --tag + --min-score + --top', () => {
  const a = parseArgs(['node', 'list.js', '--tag', 'automation', '--min-score', '70', '--top', '5']);
  assert.equal(a.tag, 'automation');
  assert.equal(a.minScore, 70);
  assert.equal(a.top, 5);
});

test('parseArgs: --this-week / --last-week populate a.week', () => {
  const a = parseArgs(['node', 'list.js', '--this-week']);
  assert.match(a.week, /^\d{4}-W\d{2}$/);
  const b = parseArgs(['node', 'list.js', '--last-week']);
  assert.match(b.week, /^\d{4}-W\d{2}$/);
  assert.notEqual(a.week, b.week);
});

test('parseArgs: --today gives a 1-day window via since/until', () => {
  const a = parseArgs(['node', 'list.js', '--today']);
  const lo = new Date(a.since).getTime();
  const hi = new Date(a.until).getTime();
  assert.equal(hi - lo, 86400_000);
});

test('parseArgs: default min-score is 60, default top is 30, default not full', () => {
  const a = parseArgs(['node', 'list.js']);
  assert.equal(a.minScore, 60);
  assert.equal(a.top, 30);
  assert.equal(a.full, false);
});

// ─── applyFilters ───────────────────────────────────────────────────

const rows = [
  { sessionId: 'a', endedAt: '2026-05-10T00:00:00Z', score: 90, tags: ['automation'], summary: 'a' },
  { sessionId: 'b', endedAt: '2026-05-15T00:00:00Z', score: 50, tags: ['chat'], summary: 'b' },
  { sessionId: 'c', endedAt: '2026-04-20T00:00:00Z', score: 85, tags: ['automation', 'meta'], summary: 'c' },
  { sessionId: 'd', endedAt: '2026-05-15T12:00:00Z', score: 75, tags: ['refactor'], summary: 'd' },
];

test('applyFilters: default minScore=60 filters out low scores', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js']));
  assert.deepEqual(out.map((r) => r.sessionId), ['a', 'c', 'd']); // 排除 b(50)
});

test('applyFilters: --full keeps all', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js', '--full']));
  assert.equal(out.length, 4);
});

test('applyFilters: --tag automation keeps only automation-tagged', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js', '--tag', 'automation']));
  assert.deepEqual(new Set(out.map((r) => r.sessionId)), new Set(['a', 'c']));
});

test('applyFilters: --month 2026-05 keeps only May sessions', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js', '--month', '2026-05', '--full']));
  assert.deepEqual(new Set(out.map((r) => r.sessionId)), new Set(['a', 'b', 'd']));
});

test('applyFilters: sorted by score desc', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js', '--full']));
  const scores = out.map((r) => r.score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], `not sorted desc: ${scores}`);
  }
});

test('applyFilters: --top N caps result count', () => {
  const out = applyFilters(rows, parseArgs(['node', 'list.js', '--full', '--top', '2']));
  assert.equal(out.length, 2);
});

// ─── toSummary ──────────────────────────────────────────────────────

test('toSummary: extracts date from endedAt', () => {
  const out = toSummary([{ sessionId: 'x', endedAt: '2026-05-15T12:34:56Z', score: 80 }]);
  assert.equal(out[0].date, '2026-05-15');
});

test('toSummary: filesEditedCount from array length', () => {
  const out = toSummary([{ sessionId: 'x', filesEdited: ['a', 'b', 'c'] }]);
  assert.equal(out[0].filesEditedCount, 3);
});

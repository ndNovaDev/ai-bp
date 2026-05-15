const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, classifyCandidates } = require('../scripts/scan');

// ─── parseArgs ────────────────────────────────────────────────────────

test('parseArgs: 默认值', () => {
  const a = parseArgs(['node', 'scan.js']);
  assert.equal(a.rescore, false);
  assert.equal(a.limit, 0);
  assert.equal(a.since, null);
  assert.equal(a.countOnly, false);
});

test('parseArgs: --count-only', () => {
  const a = parseArgs(['node', 'scan.js', '--count-only']);
  assert.equal(a.countOnly, true);
});

test('parseArgs: --count-only 可以与其他参数共存', () => {
  const a = parseArgs(['node', 'scan.js', '--count-only', '--recent', '7d']);
  assert.equal(a.countOnly, true);
  assert.ok(a.since, 'recent 7d 应该转成了 since');
});

test('parseArgs: --rescore / --force / --full 三个别名', () => {
  assert.equal(parseArgs(['node', 'x', '--rescore']).rescore, true);
  assert.equal(parseArgs(['node', 'x', '--force']).rescore, true);
  assert.equal(parseArgs(['node', 'x', '--full']).rescore, true);
});

test('parseArgs: --limit 转数字', () => {
  assert.equal(parseArgs(['node', 'x', '--limit', '10']).limit, 10);
});

// ─── classifyCandidates ───────────────────────────────────────────────

test('classifyCandidates: 全是新条目', () => {
  const files = [
    { path: '/a.jsonl', mtimeMs: 1000_000 },
    { path: '/b.jsonl', mtimeMs: 2000_000 },
  ];
  const indexMap = new Map();
  const out = classifyCandidates(files, indexMap);
  assert.equal(out.alreadyScored, 0);
  assert.equal(out.newToScore, 2);
});

test('classifyCandidates: 全部已缓存(mtime 一致)', () => {
  const files = [
    { path: '/a.jsonl', mtimeMs: 1000_000 },
    { path: '/b.jsonl', mtimeMs: 2000_000 },
  ];
  const indexMap = new Map([
    ['s1', { sessionId: 's1', jsonlPath: '/a.jsonl', jsonlMtime: 1000 }],
    ['s2', { sessionId: 's2', jsonlPath: '/b.jsonl', jsonlMtime: 2000 }],
  ]);
  const out = classifyCandidates(files, indexMap);
  assert.equal(out.alreadyScored, 2);
  assert.equal(out.newToScore, 0);
});

test('classifyCandidates: 索引里有路径但 mtime 不一致 → 算新', () => {
  const files = [{ path: '/a.jsonl', mtimeMs: 5000_000 }];
  const indexMap = new Map([
    ['s1', { sessionId: 's1', jsonlPath: '/a.jsonl', jsonlMtime: 1000 }],
  ]);
  const out = classifyCandidates(files, indexMap);
  assert.equal(out.alreadyScored, 0);
  assert.equal(out.newToScore, 1);
});

test('classifyCandidates: 混合,部分缓存部分新', () => {
  const files = [
    { path: '/a.jsonl', mtimeMs: 1000_000 }, // cached
    { path: '/b.jsonl', mtimeMs: 5000_000 }, // path 命中但 mtime 变了 → 新
    { path: '/c.jsonl', mtimeMs: 9000_000 }, // 路径不在索引 → 新
  ];
  const indexMap = new Map([
    ['s1', { sessionId: 's1', jsonlPath: '/a.jsonl', jsonlMtime: 1000 }],
    ['s2', { sessionId: 's2', jsonlPath: '/b.jsonl', jsonlMtime: 2000 }],
  ]);
  const out = classifyCandidates(files, indexMap);
  assert.equal(out.alreadyScored, 1);
  assert.equal(out.newToScore, 2);
});

test('classifyCandidates: 索引里有旧条目没记 jsonlPath → 候选全算新', () => {
  const files = [{ path: '/a.jsonl', mtimeMs: 1000_000 }];
  const indexMap = new Map([
    ['s1', { sessionId: 's1', jsonlMtime: 1000 /* 没 jsonlPath */ }],
  ]);
  const out = classifyCandidates(files, indexMap);
  assert.equal(out.newToScore, 1);
});

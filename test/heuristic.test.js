const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tryHeuristicScore, totalToolCalls, hasEditTool } = require('../scripts/lib/heuristic');

// ─── 辅助函数 ─────────────────────────────────────────────────────────

test('totalToolCalls 累加所有计数', () => {
  assert.equal(totalToolCalls({ Bash: 3, Read: 2 }), 5);
  assert.equal(totalToolCalls({}), 0);
  assert.equal(totalToolCalls(null), 0);
  assert.equal(totalToolCalls(undefined), 0);
});

test('hasEditTool 命中 Edit/Write/MultiEdit/NotebookEdit', () => {
  assert.equal(hasEditTool({ Edit: 1 }), true);
  assert.equal(hasEditTool({ Write: 2 }), true);
  assert.equal(hasEditTool({ MultiEdit: 1 }), true);
  assert.equal(hasEditTool({ NotebookEdit: 1 }), true);
  assert.equal(hasEditTool({ Read: 5, Bash: 3 }), false);
  assert.equal(hasEditTool(null), false);
});

// ─── tryHeuristicScore 触发条件 ───────────────────────────────────────

test('规则 1:短对话 + 无编辑 + 无 commit → 10 分', () => {
  const card = {
    turns: 2,
    tools: { Read: 1, Bash: 1 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  const r = tryHeuristicScore(card);
  assert.equal(r.score, 10);
  assert.equal(r.model, 'heuristic-v1');
  assert.equal(r.cost, 0);
  assert.deepEqual(r.tags, ['chat']);
  assert.equal(r.highlights.length, 0);
});

test('规则 2:工具少 + 无产出 → 15 分', () => {
  const card = {
    turns: 5,
    tools: { Read: 1, Bash: 1 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  const r = tryHeuristicScore(card);
  assert.equal(r.score, 15);
});

test('有 commit 一律不命中(交给 Haiku 判)', () => {
  const card = {
    turns: 2,
    tools: { Read: 1 },
    filesEdited: [],
    gitCommitsInWindow: ['abc123 fix bug'],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('有 filesEdited 一律不命中', () => {
  const card = {
    turns: 2,
    tools: { Edit: 1 },
    filesEdited: ['/path/file.ts'],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('有 Edit 工具一律不命中(即便 filesEdited 空)', () => {
  const card = {
    turns: 2,
    tools: { Edit: 1 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('轮次充足 + 工具多 → 不命中(留给 Haiku)', () => {
  const card = {
    turns: 8,
    tools: { Read: 4, Bash: 3, Grep: 2 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('AIBP_NO_HEURISTIC=1 关掉预筛', () => {
  const orig = process.env.AIBP_NO_HEURISTIC;
  process.env.AIBP_NO_HEURISTIC = '1';
  try {
    const card = {
      turns: 1,
      tools: {},
      filesEdited: [],
      gitCommitsInWindow: [],
    };
    assert.equal(tryHeuristicScore(card), null);
  } finally {
    if (orig === undefined) delete process.env.AIBP_NO_HEURISTIC;
    else process.env.AIBP_NO_HEURISTIC = orig;
  }
});

test('null card 安全返回 null', () => {
  assert.equal(tryHeuristicScore(null), null);
  assert.equal(tryHeuristicScore(undefined), null);
});

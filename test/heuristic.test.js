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

test('规则 4 边界:filesEdited > 2 不命中(可能是真重构没来得及 commit)', () => {
  // 0.1.45:规则 4 命中"小规模 + 无 commit + 低轮次",上限是 filesCount ≤ 2。
  // 改 3+ 文件留给 Haiku 评。
  const card = {
    turns: 2,
    tools: { Edit: 3 },
    filesEdited: ['/a.ts', '/b.ts', '/c.ts'],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('规则 4:小规模改文件 + 无 commit + 低轮次 → 30 分(0.1.45 新增)', () => {
  // 改 1-2 个文件 / 无 commit / <10 轮 — 典型的 dotfile / prompt 模板 / 试两行 → 回滚。
  // 实测这类全在 0-59 分区间,不出 gold。
  const card = {
    turns: 5,
    tools: { Edit: 2, Read: 3 },
    filesEdited: ['/path/dotfile.zshrc'],
    gitCommitsInWindow: [],
  };
  const r = tryHeuristicScore(card);
  assert.equal(r.score, 30);
  assert.deepEqual(r.tags, ['chat']);
});

test('规则 4 边界:有 commit 不命中', () => {
  // 哪怕只改 1 文件,只要 commit 了就让 Haiku 评。
  const card = {
    turns: 5,
    tools: { Edit: 1 },
    filesEdited: ['/a.ts'],
    gitCommitsInWindow: ['abc fix typo'],
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

test('规则 3:中等长度 + 零产出 → 20 分(0.1.41 新增)', () => {
  // 8 轮、9 个工具、没编辑、没 commit、没文件 — 实测 Haiku 给这类 0-59 分,
  // 0.1.41 起本地直接判 20 分,省 Haiku 调用。
  const card = {
    turns: 8,
    tools: { Read: 4, Bash: 3, Grep: 2 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  const r = tryHeuristicScore(card);
  assert.equal(r.score, 20);
  assert.deepEqual(r.tags, ['chat']);
});

test('规则 3 边界:turns=20 留给 Haiku(0.1.45 放宽到 <20)', () => {
  const card = {
    turns: 20,
    tools: { Read: 3, Bash: 3 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('规则 3 边界:totalTools=15 留给 Haiku(0.1.45 放宽到 <15)', () => {
  const card = {
    turns: 5,
    tools: { Read: 8, Bash: 7 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('规则 3 放宽后:turns=15 + totalTools=12 + 零产出 命中 20 分', () => {
  // 0.1.45 把上限从 turns<12/totalTools<10 放到 <20/<15,这条原本撞 Haiku,现在 heur 接住
  const card = {
    turns: 15,
    tools: { Read: 7, Bash: 5 },
    filesEdited: [],
    gitCommitsInWindow: [],
  };
  const r = tryHeuristicScore(card);
  assert.equal(r.score, 20);
});

test('规则 3:有 commit 不命中', () => {
  const card = {
    turns: 8,
    tools: { Read: 4, Bash: 3 },
    filesEdited: [],
    gitCommitsInWindow: ['abc fix'],
  };
  assert.equal(tryHeuristicScore(card), null);
});

test('规则 3:有 Edit 工具不命中(即便 filesEdited 空)', () => {
  const card = {
    turns: 8,
    tools: { Edit: 1, Read: 4 },
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

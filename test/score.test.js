const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildUserPrompt, parseResult, SCORE_SCHEMA, SYSTEM } = require('../scripts/lib/score');

// ─── SYSTEM / SCHEMA sanity ────────────────────────────────────────────

test('SYSTEM 提示包含评分维度关键词', () => {
  assert.match(SYSTEM, /评分维度/);
  assert.match(SYSTEM, /可复用性/);
  assert.match(SYSTEM, /JSON/);
});

test('SCORE_SCHEMA 强制 score/summary/highlights/tags 必填', () => {
  assert.deepEqual(new Set(SCORE_SCHEMA.required), new Set(['score', 'summary', 'highlights', 'tags']));
  assert.equal(SCORE_SCHEMA.properties.score.type, 'integer');
  assert.equal(SCORE_SCHEMA.properties.score.minimum, 0);
  assert.equal(SCORE_SCHEMA.properties.score.maximum, 100);
});

// ─── buildUserPrompt ───────────────────────────────────────────────────

const sampleCard = {
  sessionId: 'sess-1',
  cwd: '/Users/lqy/proj',
  startedAt: '2026-05-15T10:00:00Z',
  endedAt: '2026-05-15T11:00:00Z',
  turns: 8,
  firstPrompt: '帮我做 X',
  lastUserPrompt: '完成了吗',
  tools: { Bash: 5, Edit: 3 },
  skills: ['figma-use'],
  mcpServers: ['figma'],
  filesEdited: Array.from({ length: 20 }, (_, i) => `/path/file${i}.ts`),
  keyTurns: [{ role: 'user', text: 'X', tools: [] }],
};

test('buildUserPrompt: 嵌入 cwd / turns / tools 等关键字段', () => {
  const prompt = buildUserPrompt(sampleCard);
  assert.match(prompt, /\/Users\/lqy\/proj/);
  assert.match(prompt, /"turns": 8/);
  assert.match(prompt, /figma-use/);
  assert.match(prompt, /"Bash": 5/);
});

test('buildUserPrompt: filesEditedSample 截断到 8 条', () => {
  const prompt = buildUserPrompt(sampleCard);
  // 解析出嵌入的 JSON 块来验证
  const m = prompt.match(/\[会话卡片 JSON\]\n([\s\S]+?)\n\n请只输出/);
  assert.ok(m, 'prompt 结构匹配');
  const compact = JSON.parse(m[1]);
  assert.equal(compact.filesEditedCount, 20, '原始计数保留');
  assert.equal(compact.filesEditedSample.length, 8, 'sample 限制 8 条');
  assert.equal(compact.filesEditedSample[0], '/path/file0.ts');
});

test('buildUserPrompt: 包含输出格式指令', () => {
  const prompt = buildUserPrompt(sampleCard);
  assert.match(prompt, /请只输出一个 JSON 对象/);
  assert.match(prompt, /"score": 0-100/);
  assert.match(prompt, /"tags":/);
});

// ─── parseResult ───────────────────────────────────────────────────────

test('parseResult: 优先使用 structured_output', () => {
  const stdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'something else entirely',
    structured_output: { score: 75, summary: 's', highlights: ['h1'], tags: ['automation'] },
    total_cost_usd: 0.01,
  });
  const r = parseResult(stdout);
  assert.equal(r.score, 75);
  assert.equal(r.summary, 's');
  assert.deepEqual(r.highlights, ['h1']);
  assert.deepEqual(r.tags, ['automation']);
  assert.equal(r.cost, 0.01);
});

test('parseResult: 回退到 result 文本(无 structured_output)', () => {
  const inner = { score: 50, summary: 'fallback', highlights: [], tags: ['chat'] };
  const stdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: JSON.stringify(inner),
    total_cost_usd: 0.005,
  });
  const r = parseResult(stdout);
  assert.equal(r.score, 50);
  assert.equal(r.summary, 'fallback');
  assert.equal(r.cost, 0.005);
});

test('parseResult: 容错 ```json … ``` 围栏', () => {
  const inner = { score: 88, summary: 'fenced', highlights: ['h'], tags: ['meta'] };
  const stdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: '```json\n' + JSON.stringify(inner) + '\n```',
    total_cost_usd: 0.003,
  });
  const r = parseResult(stdout);
  assert.equal(r.score, 88);
  assert.equal(r.summary, 'fenced');
});

test('parseResult: score 自动 clamp 到 [0,100]', () => {
  const high = JSON.stringify({
    is_error: false,
    structured_output: { score: 150, summary: 's', highlights: [], tags: [] },
  });
  const low = JSON.stringify({
    is_error: false,
    structured_output: { score: -20, summary: 's', highlights: [], tags: [] },
  });
  assert.equal(parseResult(high).score, 100);
  assert.equal(parseResult(low).score, 0);
});

test('parseResult: score 浮点 round 到整数', () => {
  const stdout = JSON.stringify({
    is_error: false,
    structured_output: { score: 72.6, summary: 's', highlights: [], tags: [] },
  });
  assert.equal(parseResult(stdout).score, 73);
});

test('parseResult: highlights 截断到 3 条,tags 截断到 6 条', () => {
  const stdout = JSON.stringify({
    is_error: false,
    structured_output: {
      score: 80,
      summary: 's',
      highlights: ['1', '2', '3', '4', '5'],
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    },
  });
  const r = parseResult(stdout);
  assert.equal(r.highlights.length, 3);
  assert.equal(r.tags.length, 6);
});

test('parseResult: is_error=true 抛出', () => {
  const stdout = JSON.stringify({
    is_error: true,
    result: 'rate limit',
  });
  assert.throws(() => parseResult(stdout), /claude error/);
});

test('parseResult: 非 JSON 数组的 highlights/tags 给空数组', () => {
  const stdout = JSON.stringify({
    is_error: false,
    structured_output: { score: 60, summary: 's', highlights: null, tags: 'not array' },
  });
  const r = parseResult(stdout);
  assert.deepEqual(r.highlights, []);
  assert.deepEqual(r.tags, []);
});

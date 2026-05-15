const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  titleToSlug,
  detectBanned,
  extractTitle,
  AUDITOR_LENS,
  BANNED_PHRASES,
} = require('../scripts/lib/draft');

// ─── AUDITOR_LENS sanity ──────────────────────────────────────────────

test('AUDITOR_LENS 包含 7 条探针的关键概念', () => {
  // 不锁死措辞,只确认核心维度都在
  for (const keyword of ['真实性', '难度', '成熟度', '沉淀', '杠杆', '诚实', 'STAR']) {
    assert.match(AUDITOR_LENS, new RegExp(keyword), `缺少 ${keyword}`);
  }
});

// ─── titleToSlug ──────────────────────────────────────────────────────

test('titleToSlug: 纯英文', () => {
  assert.equal(titleToSlug('Hello World'), 'hello-world');
});

test('titleToSlug: 中文保留', () => {
  assert.equal(titleToSlug('会话评分流水线工程化'), '会话评分流水线工程化');
});

test('titleToSlug: 中英混合,标点和空白归一', () => {
  assert.equal(titleToSlug('AI 最佳实践:会话评分!'), 'ai-最佳实践会话评分');
});

test('titleToSlug: 多空白和多 - 都折成单个', () => {
  assert.equal(titleToSlug('  foo   bar - baz  '), 'foo-bar-baz');
});

test('titleToSlug: 空 / null / 全标点 → untitled', () => {
  assert.equal(titleToSlug(''), 'untitled');
  assert.equal(titleToSlug(null), 'untitled');
  assert.equal(titleToSlug('...!!!'), 'untitled');
});

test('titleToSlug: 截断到 60 字符,不留尾随 -', () => {
  const long = 'a'.repeat(50) + '-' + 'b'.repeat(50);
  const slug = titleToSlug(long);
  assert.ok(slug.length <= 60, `slug length ${slug.length} > 60`);
  assert.ok(!slug.endsWith('-'), 'slug 不能以 - 结尾');
});

// ─── detectBanned ─────────────────────────────────────────────────────

test('detectBanned: 干净文本返回空数组', () => {
  const md = '# 标题\n\n本次产出了一个 plugin,降低了下次类似场景的边际成本。';
  assert.deepEqual(detectBanned(md), []);
});

test('detectBanned: 命中典型 LLM 套路', () => {
  const md = '本次工作中,我使用了 Claude Code,可以说效果显著。';
  const hits = detectBanned(md);
  assert.ok(hits.includes('使用了'), '应命中 "使用了"');
  assert.ok(hits.includes('可以说'), '应命中 "可以说"');
});

test('BANNED_PHRASES 覆盖几个高频 LLM 词', () => {
  for (const p of ['使用了', '调用了', '可以说', '综上所述']) {
    assert.ok(BANNED_PHRASES.includes(p), `BANNED_PHRASES 缺 ${p}`);
  }
});

// ─── extractTitle ─────────────────────────────────────────────────────

test('extractTitle: 从第一行 H1 提取', () => {
  assert.equal(extractTitle('# 会话评分流水线工程化\n\n正文...'), '会话评分流水线工程化');
});

test('extractTitle: 没 H1 时返回 untitled', () => {
  assert.equal(extractTitle('## 副标题\n\n正文'), 'untitled');
  assert.equal(extractTitle(''), 'untitled');
});

// ─── 模板已删除,确认 draft.js 不再导出它们 ──────────────────────────

test('lib/draft.js 只暴露 utils,不再有 prompt 模板', () => {
  const draft = require('../scripts/lib/draft');
  // 模板字符串构造函数 + JSON schema 都已废弃,起草由主 Claude 全权驱动
  assert.equal(typeof draft.buildProbePrompt, 'undefined');
  assert.equal(typeof draft.buildFinalizePrompt, 'undefined');
  assert.equal(typeof draft.PROBE_SCHEMA, 'undefined');
  // 子进程版本的遗留更早就删了,顺手再确认一下
  assert.equal(typeof draft.proposeAndProbe, 'undefined');
  assert.equal(typeof draft.finalize, 'undefined');
  assert.equal(typeof draft.MODEL, 'undefined');
});

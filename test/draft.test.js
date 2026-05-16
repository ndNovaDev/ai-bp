const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  titleToSlug,
  extractTitle,
  STYLE_GUIDE,
} = require('../scripts/lib/draft');

// ─── STYLE_GUIDE sanity ──────────────────────────────────────────────

test('STYLE_GUIDE 存在且很短(防止退化成均值化锚点)', () => {
  // v3 设计:短风格方向锚,3-8 行预期。测试上限 20 行 —
  // 防止 future-self 塞回长篇 style brief 或 do/don't 清单(那会回到
  // AUDITOR_LENS / AI_TELLS 的失败模式:规则本身变成均值化锚点)
  assert.equal(typeof STYLE_GUIDE, 'string');
  const lines = STYLE_GUIDE.split('\n').length;
  assert.ok(lines <= 20, `STYLE_GUIDE 有 ${lines} 行,超过上限 20`);
});

test('STYLE_GUIDE 不复刻 AI_TELLS / AUDITOR_LENS 的形式审计语言', () => {
  // 这些词进了 STYLE_GUIDE 就意味着退化回 "列规则" 模式
  for (const banned of ['密度', '否定式对仗', '挂尾', 'inline-header', '营销腔', '学术腔']) {
    assert.doesNotMatch(STYLE_GUIDE, new RegExp(banned, 'i'), `STYLE_GUIDE 不应包含 "${banned}"`);
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

// ─── extractTitle ─────────────────────────────────────────────────────

test('extractTitle: 从第一行 H1 提取', () => {
  assert.equal(extractTitle('# 会话评分流水线工程化\n\n正文...'), '会话评分流水线工程化');
});

test('extractTitle: 没 H1 时返回 untitled', () => {
  assert.equal(extractTitle('## 副标题\n\n正文'), 'untitled');
  assert.equal(extractTitle(''), 'untitled');
});

// ─── 历代约束都已删除,确认不再 export ─────────────────────────────────

test('lib/draft.js 只暴露 STYLE_GUIDE + utils, 历代约束都删了', () => {
  const draft = require('../scripts/lib/draft');
  // v1: 内容审计探针 + 黑名单 + 结构模板
  assert.equal(typeof draft.AUDITOR_LENS, 'undefined');
  assert.equal(typeof draft.BANNED_PHRASES, 'undefined');
  assert.equal(typeof draft.detectBanned, 'undefined');
  // 子进程版本 prompt 构造 + schema
  assert.equal(typeof draft.buildProbePrompt, 'undefined');
  assert.equal(typeof draft.buildFinalizePrompt, 'undefined');
  assert.equal(typeof draft.PROBE_SCHEMA, 'undefined');
  assert.equal(typeof draft.proposeAndProbe, 'undefined');
  assert.equal(typeof draft.finalize, 'undefined');
  assert.equal(typeof draft.MODEL, 'undefined');
  // v2: AI_TELLS 形式自检 — 换成预设结构 + 短 STYLE_GUIDE 后不再需要
  assert.equal(typeof draft.AI_TELLS, 'undefined');
});

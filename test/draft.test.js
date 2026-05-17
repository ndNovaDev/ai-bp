const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  titleToSlug,
  extractTitle,
} = require('../scripts/lib/draft');

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

test('lib/draft.js 只暴露 titleToSlug + extractTitle, 历代约束/锚点都删了', () => {
  const draft = require('../scripts/lib/draft');
  // v3 STYLE_GUIDE 也已经删除
  assert.equal(typeof draft.STYLE_GUIDE, 'undefined');
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
  // v2: AI_TELLS 形式自检
  assert.equal(typeof draft.AI_TELLS, 'undefined');
});

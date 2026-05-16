const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  titleToSlug,
  extractTitle,
  AI_TELLS,
} = require('../scripts/lib/draft');

// ─── AI_TELLS sanity ──────────────────────────────────────────────────

test('AI_TELLS 包含 6 类结构性 tell 的关键概念', () => {
  // 来源 Wikipedia:Signs of AI writing,核心 6 类必须都在
  for (const keyword of ['否定式对仗', '三项并列', '挂尾', 'inline-header', 'outline', '向均值回归']) {
    assert.match(AI_TELLS, new RegExp(keyword, 'i'), `缺少 ${keyword}`);
  }
});

test('AI_TELLS 明确"不是有没有,是密度"的判别原则', () => {
  // 这条原则是 AI_TELLS 的元规则,删了就退化成 BANNED_PHRASES
  assert.match(AI_TELLS, /密度/);
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

// ─── 模板已删除,确认 draft.js 不再导出它们 ──────────────────────────

test('lib/draft.js 只暴露 utils 和 AI_TELLS,内容审计 / 模板 / 黑名单都删了', () => {
  const draft = require('../scripts/lib/draft');
  // 模板字符串构造函数 + JSON schema 都已废弃,起草由主 Claude 全权驱动
  assert.equal(typeof draft.buildProbePrompt, 'undefined');
  assert.equal(typeof draft.buildFinalizePrompt, 'undefined');
  assert.equal(typeof draft.PROBE_SCHEMA, 'undefined');
  // 子进程版本的遗留更早就删了,顺手再确认一下
  assert.equal(typeof draft.proposeAndProbe, 'undefined');
  assert.equal(typeof draft.finalize, 'undefined');
  assert.equal(typeof draft.MODEL, 'undefined');
  // BANNED_PHRASES 黑名单删了 — 重写循环换不掉等价 LLM 套话,只会多花 token
  assert.equal(typeof draft.BANNED_PHRASES, 'undefined');
  assert.equal(typeof draft.detectBanned, 'undefined');
  // AUDITOR_LENS 删了 — 改成"采样用户真实发言、模仿语气"之后,内容审计约束反而成了均值化锚点
  assert.equal(typeof draft.AUDITOR_LENS, 'undefined');
});

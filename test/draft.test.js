const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  titleToSlug,
  detectBanned,
  extractTitle,
  buildProbePrompt,
  buildFinalizePrompt,
  AUDITOR_LENS,
  BANNED_PHRASES,
  PROBE_SCHEMA,
} = require('../scripts/lib/draft');

// ─── AUDITOR_LENS / SCHEMA sanity ─────────────────────────────────────

test('AUDITOR_LENS 包含 7 条探针的关键概念', () => {
  // 不锁死措辞,只确认核心维度都在
  for (const keyword of ['真实性', '难度', '成熟度', '沉淀', '杠杆', '诚实', 'STAR']) {
    assert.match(AUDITOR_LENS, new RegExp(keyword), `缺少 ${keyword}`);
  }
});

test('PROBE_SCHEMA 强制 proposedTitle / draftSTAR / questions 必填', () => {
  assert.deepEqual(
    new Set(PROBE_SCHEMA.required),
    new Set(['proposedTitle', 'draftSTAR', 'questions']),
  );
  // 固定 4 道(S/T/A/R 各一),好压到一次 AskUserQuestion 调用里(API 上限 4 题)。
  assert.equal(PROBE_SCHEMA.properties.questions.minItems, 4);
  assert.equal(PROBE_SCHEMA.properties.questions.maxItems, 4);
  const q = PROBE_SCHEMA.properties.questions.items;
  assert.deepEqual(new Set(q.required), new Set(['module', 'prompt', 'options']));
  assert.deepEqual(q.properties.module.enum, ['S', 'T', 'A', 'R']);
  assert.equal(q.properties.options.minItems, 2);
  assert.equal(q.properties.options.maxItems, 3);
});

test('buildProbePrompt: 明确"正好 4 题、S→T→A→R 顺序"', () => {
  const p = buildProbePrompt({ rangeLabel: '2026-W20', evidencePack: sampleEvidence });
  assert.match(p, /4 道/);
  assert.match(p, /S→T→A→R|S\s*→\s*T\s*→\s*A\s*→\s*R/);
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

// ─── prompt builders ──────────────────────────────────────────────────

const sampleEvidence = {
  sessionId: 'abc-123',
  cwd: '/Users/foo/proj',
  score: 82,
  summary: '把会话评分流程工程化',
  highlights: ['STAR 拆分', '禁用词后置检测'],
  tags: ['automation', 'meta'],
  filesEdited: ['/Users/foo/proj/scripts/lib/draft.js'],
  gitLog: ['c027a71 move data outside'],
  jsonlHead: 'user: 我想把这个流程工程化',
  jsonlTail: 'assistant: 完成 47 个测试',
};

test('buildProbePrompt: 嵌入证据包关键字段', () => {
  const p = buildProbePrompt({ rangeLabel: '2026-W20', evidencePack: sampleEvidence });
  assert.match(p, /2026-W20/);
  assert.match(p, /abc-123/);
  assert.match(p, /会话评分/);
  assert.match(p, /proposedTitle/);
  assert.match(p, /questions/);
});

test('buildFinalizePrompt: 单案例结构提示', () => {
  const p = buildFinalizePrompt({
    rangeLabel: '2026-W20',
    evidencePack: sampleEvidence,
    drafts: { situation: 's', task: 't', action: 'a', result: 'r' },
    answers: [{ module: 'S', prompt: 'why?', answer: 'because' }],
    hasMultipleCases: false,
  });
  assert.match(p, /H1 直接用案例名/);
  assert.match(p, /不要 H2/);
  assert.match(p, /单案例/);
});

test('buildFinalizePrompt: 多案例结构提示', () => {
  const p = buildFinalizePrompt({
    rangeLabel: '2026-W20',
    evidencePack: [sampleEvidence, sampleEvidence],
    drafts: [{}, {}],
    answers: [],
    hasMultipleCases: true,
  });
  assert.match(p, /多案例/);
  assert.match(p, /H1 用期号/);
});

test('buildFinalizePrompt: 把所有 BANNED_PHRASES 列进提示', () => {
  const p = buildFinalizePrompt({
    rangeLabel: 'X',
    evidencePack: sampleEvidence,
    drafts: {},
    answers: [],
    hasMultipleCases: false,
  });
  for (const banned of BANNED_PHRASES) {
    assert.ok(p.includes(banned), `finalize prompt 缺 BANNED_PHRASES 项: ${banned}`);
  }
});

test('buildFinalizePrompt: 用户未答复的问题保留 "(用户未明确)"', () => {
  const p = buildFinalizePrompt({
    rangeLabel: 'X',
    evidencePack: sampleEvidence,
    drafts: {},
    answers: [{ module: 'T', prompt: '你的目标是?', answer: null }],
    hasMultipleCases: false,
  });
  assert.match(p, /用户未明确/);
});

// ─── 主对话起草:确保 AUDITOR_LENS 内嵌、bannedHits 注入触发重写 ────────

test('buildProbePrompt: AUDITOR_LENS 内嵌(不再依赖 --append-system-prompt)', () => {
  const p = buildProbePrompt({ rangeLabel: 'X', evidencePack: sampleEvidence });
  assert.match(p, /审计 AI/);
  assert.match(p, /STAR/);
  assert.match(p, /边际成本/);
});

test('buildFinalizePrompt: AUDITOR_LENS 内嵌', () => {
  const p = buildFinalizePrompt({
    rangeLabel: 'X', evidencePack: sampleEvidence,
    drafts: {}, answers: [], hasMultipleCases: false,
  });
  assert.match(p, /审计 AI/);
});

test('buildFinalizePrompt: 无 bannedHits 时不带重写指令', () => {
  const p = buildFinalizePrompt({
    rangeLabel: 'X', evidencePack: sampleEvidence,
    drafts: {}, answers: [], hasMultipleCases: false,
  });
  assert.doesNotMatch(p, /\[重写要求\]/);
});

test('buildFinalizePrompt: bannedHits 非空时注入重写指令并列出命中词', () => {
  const p = buildFinalizePrompt({
    rangeLabel: 'X', evidencePack: sampleEvidence,
    drafts: {}, answers: [], hasMultipleCases: false,
    bannedHits: ['使用了', '可以说'],
  });
  assert.match(p, /\[重写要求\]/);
  assert.match(p, /使用了/);
  assert.match(p, /可以说/);
  assert.match(p, /重写/);
});

test('lib/draft.js 不再 spawn 子进程(没有 proposeAndProbe / finalize / MODEL)', () => {
  const draft = require('../scripts/lib/draft');
  assert.equal(typeof draft.proposeAndProbe, 'undefined');
  assert.equal(typeof draft.finalize, 'undefined');
  assert.equal(typeof draft.MODEL, 'undefined');
});

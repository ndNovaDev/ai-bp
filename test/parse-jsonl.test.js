const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { buildSessionCard, gitCommitsInWindow, extractUserTurns } = require('../scripts/lib/parse-jsonl');

const FIXTURES = path.join(__dirname, 'fixtures');

test('buildSessionCard: small session — basic fields', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'small.jsonl'));
  assert.equal(card.sessionId, 'sess-small-01');
  assert.equal(card.cwd, '/Users/lqy/proj-a');
  assert.equal(card.startedAt, '2026-05-10T10:00:00.000Z');
  assert.equal(card.endedAt, '2026-05-10T10:00:07.000Z');
  assert.equal(card.firstPrompt, '帮我看一下分支');
  assert.equal(typeof card.jsonlMtime, 'number');
  assert.ok(card.jsonlMtime > 0);
});

test('buildSessionCard: turns counts only user text messages (not tool_result)', async () => {
  // small.jsonl 有 1 个 user text + 1 个 user 是 tool_result(应被忽略)
  const card = await buildSessionCard(path.join(FIXTURES, 'small.jsonl'));
  assert.equal(card.turns, 1, 'tool_result 类的 user 消息不计入 turns');
});

test('buildSessionCard: tools aggregated correctly', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  assert.equal(card.tools.Read, 1);
  assert.equal(card.tools.Edit, 1);
  assert.equal(card.tools.Write, 1);
  assert.equal(card.tools.Bash, 1);
  assert.equal(card.tools.Skill, 1);
  // MCP 工具也计在 tools 里(以全名为 key)
  assert.equal(card.tools['mcp__figma__get_design_context'], 1);
  assert.equal(card.tools['mcp__context7__resolve-library-id'], 1);
});

test('buildSessionCard: skill name extracted from Skill tool input', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  assert.deepEqual(card.skills, ['figma-use']);
});

test('buildSessionCard: mcpServers extracted from mcp__<server>__<method>', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  assert.deepEqual(new Set(card.mcpServers), new Set(['figma', 'context7']));
});

test('buildSessionCard: filesEdited collected from Edit/Write', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  assert.deepEqual(new Set(card.filesEdited), new Set([
    '/Users/lqy/proj-b/Button.tsx',
    '/Users/lqy/.claude/skills/figma-sync/SKILL.md',
  ]));
});

test('buildSessionCard: keyTurns picks long user prompts and tool-dense assistant', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  // rich.jsonl 第一条 user 是 ≥80 字的长 prompt,assistant 1 有 4 个 tools,assistant 2 有 3 个 tools
  // 应该至少挑到这 3 个,最多 5 个
  assert.ok(card.keyTurns.length >= 2 && card.keyTurns.length <= 5);
  // 第一条长 prompt 一定被选中
  const hasLongUser = card.keyTurns.some(
    (t) => t.role === 'user' && t.text.includes('请用 figma MCP'),
  );
  assert.ok(hasLongUser, 'first long user prompt should be picked');
  // 至少一个 tool-dense assistant 被选中
  const hasDenseAssistant = card.keyTurns.some(
    (t) => t.role === 'assistant' && t.tools.length >= 3,
  );
  assert.ok(hasDenseAssistant, 'tool-dense assistant should be picked');
});

test('buildSessionCard: empty jsonl yields turns=0, no firstPrompt', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'empty.jsonl'));
  assert.equal(card.sessionId, 'sess-empty-01');
  assert.equal(card.turns, 0);
  assert.equal(card.firstPrompt, '');
  assert.deepEqual(card.tools, {});
  assert.equal(card.keyTurns.length, 0);
});

test('buildSessionCard: malformed lines are skipped, not fatal', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'malformed.jsonl'));
  assert.equal(card.sessionId, 'sess-mal-01');
  assert.equal(card.cwd, '/Users/lqy/proj-c');
  assert.equal(card.turns, 2, '两条有效 user text');
  assert.equal(card.firstPrompt, '测试malformed 行处理');
});

test('gitCommitsInWindow: 非 git cwd 返回 []', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibp-nongit-'));
  try {
    const out = await gitCommitsInWindow(tmp, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
    assert.deepEqual(out, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gitCommitsInWindow: cwd 为空 / startedAt 缺失 返回 []', async () => {
  assert.deepEqual(await gitCommitsInWindow('', '2020-01-01'), []);
  assert.deepEqual(await gitCommitsInWindow('/tmp', ''), []);
  assert.deepEqual(await gitCommitsInWindow(null, null), []);
});

test('gitCommitsInWindow: 窗口内 commit 能拿到,窗口外拿不到', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibp-git-'));
  try {
    const sh = (args) =>
      execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(tmp, 'f'), 'a');
    sh(['add', '.']);
    sh(['commit', '-q', '-m', 'first commit message']);

    // 窗口包含 commit:命中
    const inWin = await gitCommitsInWindow(tmp, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
    assert.equal(inWin.length, 1);
    assert.match(inWin[0], /first commit message/);

    // 窗口在 commit 之前:miss
    const before = await gitCommitsInWindow(tmp, '2020-01-01T00:00:00Z', '2020-06-01T00:00:00Z');
    assert.deepEqual(before, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildSessionCard: long text in keyTurns is clipped to ~400 chars + ellipsis', async () => {
  const card = await buildSessionCard(path.join(FIXTURES, 'rich.jsonl'));
  for (const t of card.keyTurns) {
    // 我们的 cap 是 400,加一个省略号字符,保守上限 410
    assert.ok(t.text.length <= 410, `keyTurn text too long: ${t.text.length}`);
  }
});

test('extractUserTurns: small — 1 条真实 user text,tool_result 被过滤', async () => {
  const turns = await extractUserTurns(path.join(FIXTURES, 'small.jsonl'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, '帮我看一下分支');
  assert.equal(turns[0].ts, '2026-05-10T10:00:00.000Z');
});

test('extractUserTurns: rich — 3 条 user text,按时间顺序', async () => {
  const turns = await extractUserTurns(path.join(FIXTURES, 'rich.jsonl'));
  assert.equal(turns.length, 3);
  assert.ok(turns[0].text.includes('请用 figma MCP'));
  assert.equal(turns[1].text, '很好,继续做剩下的');
  assert.equal(turns[2].text, '搞定了吗?');
  // 时间戳单调递增
  assert.ok(turns[0].ts < turns[1].ts && turns[1].ts < turns[2].ts);
});

test('extractUserTurns: malformed — 跳坏行,留 2 条', async () => {
  const turns = await extractUserTurns(path.join(FIXTURES, 'malformed.jsonl'));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, '测试malformed 行处理');
  assert.equal(turns[1].text, '再问一句');
});

test('extractUserTurns: empty — 空数组', async () => {
  const turns = await extractUserTurns(path.join(FIXTURES, 'empty.jsonl'));
  assert.deepEqual(turns, []);
});

test('extractUserTurns: maxCharsPerTurn 截断长 prompt', async () => {
  const turns = await extractUserTurns(path.join(FIXTURES, 'rich.jsonl'), { maxCharsPerTurn: 30 });
  // 第一条 ≥ 80 字的会被截断到 30 + 省略号
  assert.ok(turns[0].text.length <= 31, `expected clipped, got len=${turns[0].text.length}`);
  assert.ok(turns[0].text.endsWith('…'));
  // 短消息不变
  assert.equal(turns[1].text, '很好,继续做剩下的');
});

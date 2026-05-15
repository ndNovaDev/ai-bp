const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { buildSessionCard, gitCommitsInWindow } = require('../scripts/lib/parse-jsonl');

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code **plugin + marketplace in one repo**. Distributed via
`/plugin marketplace add ndNovaDev/ai-bp` then `/plugin install ai-best-practice@ai-bp`.
The user installs it; the plugin then watches their Claude Code sessions.

Goal: scan `~/.claude/projects/*.jsonl` history, score each session with Haiku
("AI best-practice gold value" 0–100), and let `/ai-practice-pick` turn high-scoring
sessions into a Chinese OKR weekly-report draft.

## Mandatory release checklist

Every push that ships behavior changes MUST bump the version. **Three** files carry
versions and they must stay in sync:

1. `package.json` → `version`
2. `.claude-plugin/plugin.json` → `version`
3. `.claude-plugin/marketplace.json` → both `version` (top-level) and `plugins[0].version`

Then commit, then push. Pushing without a version bump means existing installs won't
pick up the change via `/plugin update`.

## Common commands

```bash
# Run full test suite (47 tests, node --test, zero deps)
env -u _VOLTA_TOOL_RECURSION node --test test/*.test.js

# Run a single test file
env -u _VOLTA_TOOL_RECURSION node --test test/score.test.js

# Smoke-test the data pipeline end-to-end without the hook
node scripts/scan.js --limit 1          # score 1 jsonl
node scripts/list.js --top 3            # read back from index
node scripts/parse-jsonl.js <jsonl>     # dump a session card (no scoring)
```

The repo has no `package.json` deps, no lint, no build. Node ≥ 18 is the only requirement.
The `env -u _VOLTA_TOOL_RECURSION` prefix is needed under Volta (see global CLAUDE.md).

## Data layout (critical — easy to get wrong)

**Data does NOT live in the repo.** It lives at `~/.claude/ai-best-practice/`:

```
~/.claude/ai-best-practice/
├── data/index.jsonl     # one row per session, sessionId is primary key
└── weekly/<range>.md    # /ai-practice-pick output
```

Path resolution is centralized in `scripts/lib/paths.js`. Override the root with
`AIBP_DATA_DIR`. That module also runs a one-time migration on import: if legacy
`<repo>/data/index.jsonl` or `<repo>/weekly/*` exist, they get moved to the new
location. Don't add new code that hardcodes `PLUGIN_ROOT + '/data'`.

Logs (separate from data): `~/.claude/logs/ai-best-practice.log`.

## Architecture

Two trigger paths converge on the same scoring pipeline:

```
Stop hook → hooks/on-stop.sh → scripts/scan-session.js ─┐
                                                        │
/ai-practice-scan → scripts/scan.js (batch + cache) ────┤→ lib/parse-jsonl → lib/score → INDEX_PATH
                                                        │
/ai-practice-pick → scripts/list.js → lib/draft.js (proposeAndProbe → 采访 → finalize) → WEEKLY_DIR
```

**起草流程(`lib/draft.js`)是两阶段交互式的**,不是一次 LLM 大调用:
1. `proposeAndProbe(evidencePack)` → STAR 初稿 + 3-5 道采访问题(LLM 看不出的事:动机、
   真实 ROI、备选方案、复用面)
2. slash command 在主对话里用 `AskUserQuestion` 逐题问用户;每题第一选项是 LLM 的最佳猜测,
   用户直接选 = 静默接受
3. `finalize({drafts, answers, hasMultipleCases})` → 终稿,内部跑 `BANNED_PHRASES` 后置
   检测,命中则重写一次
4. 整套起草服务一个假想敌:公司"AI 最佳实践审计 AI",见 `AUDITOR_LENS` 常量
5. 单案例 H1 直接是案例名,无 H2;多案例 H1 是期号,每案 H2 是案例名

Key design points to preserve when modifying:

- **All LLM calls shell out to `claude -p`**. We never import `@anthropic-ai/sdk`.
  Auth is whatever the user already logged into Claude Code with. See `lib/score.js`
  and `lib/draft.js` for the `spawn('claude', [...])` pattern. Both use
  `--bare --no-session-persistence` so the scorer's own sessions don't get re-indexed.
- **mtime cache** in `scan.js` / `scan-session.js`: a row is skipped when
  `existing.jsonlMtime === card.jsonlMtime`. Don't break this; full re-scoring 340
  sessions costs ~$10.
- **Stub filter**: `claude -p --no-session-persistence` still writes a ~120-byte
  ai-title stub into `~/.claude/projects/`. `scan.js` drops anything under 500B
  (`STUB_SIZE_THRESHOLD`) before paying parse cost.
- **Score parse retry**: `lib/score.js#scoreCard` retries once on JSON parse error
  only (not on timeout/crash) — Haiku occasionally ignores the schema. SYSTEM is
  deliberately strict ("第一个字符必须是 `{`"); don't soften it.
- **Hook is best-effort**: `on-stop.sh` backgrounds `nohup node scan-session.js` and
  always `exit 0`. Failures only go to the log; never block session shutdown.
- **Slash commands take natural-language args**. `commands/ai-practice-{scan,pick}.md`
  contain mapping tables (Chinese phrase → CLI flag). Claude itself does the
  translation in-conversation; the scripts only see flags like `--recent 7d`.

## Testing model

Tests are pure unit tests against `lib/parse-jsonl.js`, `lib/score.js` (parsing/prompt
building, not actual LLM calls), and `list.js` filter logic. Fixtures are in
`test/fixtures/`. No integration test hits `claude -p` — keep it that way.

If you change `buildUserPrompt` in `lib/score.js`, the prompt-shape regexes in
`test/score.test.js` will likely need updating; use `\s?` between key/value when
asserting JSON substrings since the prompt embeds compact (no-space) JSON.

## Style notes

- CommonJS (`require` / `module.exports`) throughout. TypeScript's `[80001]`
  diagnostic suggesting ESM conversion is noise — ignore it.
- Comments in code are mostly Chinese; keep that convention for new code in the same files.

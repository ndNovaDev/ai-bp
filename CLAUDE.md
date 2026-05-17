# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code **plugin + marketplace in one repo**. Distributed via
`/plugin marketplace add ndNovaDev/ai-bp` then `/plugin install ai-best-practice@ai-bp`.
The user installs it; the plugin then watches their Claude Code sessions.

Goal: scan `~/.claude/projects/*.jsonl` history, score each session with Haiku
("AI best-practice gold value" 0–100), and let `/ai-practice-pick` turn high-scoring
sessions into a **final-form** Chinese OKR weekly-report (not a draft — landed file
is the deliverable).

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
# Run full test suite (86 tests, node --test, zero deps)
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

**Data does NOT live in the repo, and does NOT live under `~/.claude/`.** It lives
at `~/.ai-best-practice/`:

```
~/.ai-best-practice/
├── data/index.jsonl     # one row per session, sessionId is primary key
├── weekly/<期号>-<slug>.md   # /ai-practice-pick output
└── logs/ai-best-practice.log # all log output (hook + scan + score)
```

**HARD RULE: this plugin must never write under `~/.claude/`.** macOS Sequoia tags
`~/.claude/` with `com.apple.provenance` for the Anthropic team (the `claude` CLI's
signing identity, `com.anthropic.claude-code` / `Q6L2SF6YDW`). Our scripts run under
`node` (Volta team `HX7739G8FX`), so any write into a `~/.claude/` subdir is a
cross-team modification and triggers the iTerm/Terminal App Management permission
dialog repeatedly. Reads from `~/.claude/projects/` are fine (read doesn't trigger).
If you ever feel tempted to drop a file under `~/.claude/`, use `paths.js` constants
instead.

Path resolution is centralized in `scripts/lib/paths.js`. Override the root with
`AIBP_DATA_DIR`. That module runs a one-time migration on import: if legacy
locations (`<repo>/data/`, `~/.claude/ai-best-practice/`, `~/.claude/logs/...log`)
exist, they get moved to the new home. Don't add new code that hardcodes any of
these paths — always import from `paths.js`.

## Architecture

Two trigger paths converge on the same scoring pipeline:

```
SessionEnd hook → hooks/on-stop.sh → scripts/scan-session.js ─┐
                                                              │
/ai-practice-scan → scripts/scan.js (batch + cache) ──────────┤→ lib/parse-jsonl → lib/score → INDEX_PATH
                                                        │
/ai-practice-pick → scripts/list.js → 主对话直接写最终稿(锚 user 原话,不锚 Haiku 摘要)→ WEEKLY_DIR
```

**起草流程在 `commands/ai-practice-pick.md`,历代失败模式在 `scripts/lib/draft.js` 头注(单行回顾)。** 当前 step 5 只有四条方向性约束(王小波口吻 / 金字塔原理结构 / 避免"知识的诅咒" / 读者画像是审稿 AI + 公司领导),外加一条硬约束(只锚 user 原始消息,不许碰 Haiku 摘要)。不要再加 `claude -p` 子进程起草、AUDITOR_LENS、AI_TELLS、摸用户语气画像、句式打散、Peterson 多步骤、多路 peer review 这类东西 — 全部已被证伪,见 draft.js 头注。

Key design points to preserve when modifying:

- **Scoring 走子进程,Drafting 不走**:`lib/score.js` `spawn('claude', [...])` 跑 Haiku
  (`--bare --no-session-persistence` 防止 scorer 自己的会话被 hook 递归索引)。
  Drafting 直接在主对话里跑,复用主会话鉴权 + 1M context,避开 Anthropic 长上下文 Extra Usage 计费档。
- **mtime cache** in `scan.js` / `scan-session.js`: a row is skipped when
  `existing.jsonlMtime === card.jsonlMtime`. Don't break this — full re-scoring
  the author's local 346-session corpus cost ~$10, and the cache is the only
  thing keeping daily runs free.
- **Preflight calibration**: `scan.js --count-only` returns
  `{candidates, alreadyScored, newToScore, concurrency, indexSize}` as JSON for
  the slash command's preflight. The slash command then runs `--limit 10` as a
  calibration batch, reads the `[scan] done` summary line's `avg_cost` /
  `avg_sec` to extrapolate the remainder, and asks the user via
  `AskUserQuestion` before the full run. The 10 calibration items get mtime-
  cached so the second run doesn't double-charge.
- **Stub filter**: `claude -p --no-session-persistence` still writes a ~120-byte
  ai-title stub into `~/.claude/projects/`. `scan.js` drops anything under 500B
  (`STUB_SIZE_THRESHOLD`) before paying parse cost.
- **Hook is best-effort + uses SessionEnd not Stop**: `on-stop.sh` backgrounds
  `nohup node scan-session.js` and always `exit 0`. Failures only go to the log;
  never block session shutdown. The hook is wired to **SessionEnd** (fires once
  per session) rather than **Stop** (would fire after every assistant turn —
  burns Haiku $ on long sessions). Don't switch back to `Stop` without restoring
  an aggressive debounce.
- **Hook unreliability is handled by auto-scan-on-pick**: SessionEnd misses
  `/exit` (Claude Code issue #35892), close-window (SIGHUP), Cmd+Q, kill — so
  `/ai-practice-pick` runs `scripts/scan.js --recent 14d` as step 0.5 before
  doing anything else. mtime cache means already-indexed sessions skip cheaply.
  The user never has to remember `/ai-practice-scan` — it stays as the manual
  "rescan beyond 14d" escape hatch.
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

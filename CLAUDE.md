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
/ai-practice-pick → scripts/list.js → lib/draft.js (buildProbePrompt → 主对话起草 → 采访 → buildFinalizePrompt → 主对话起草 → Write) → WEEKLY_DIR
```

**起草流程完全在主对话内 agent 化驱动**(不 spawn `claude -p`,不再有 prompt 模板):
1. slash command(`commands/ai-practice-pick.md`)按步描述工作流,主 Claude 用自己的工具
   (Read / Bash git)按需取证,边看边判断"够了"就停
2. 主 Claude 在自己的下一条回复里产出 proposedTitle + 1–3 道采访题(LLM 看不出的事:
   动机、真实 ROI、备选方案、复用面);题数越少越好,题数越多 5c 写作时塞答案的压力越大
3. slash command **一次** `AskUserQuestion`(API 上限 4)把题一屏问完;
   每题第一选项是 LLM 的最佳猜测,用户直接选 = 静默接受
4. 主 Claude 基于证据 + 用户答复直接产出 markdown → slash command 用 `Write` 落盘
   (不再有"落盘后 detectBanned 命中触发重写"那一环 — 重写只换等价 LLM 套话,无效)
5. 整套起草服务一个假想敌:公司"AI 最佳实践审计 AI",见 `AUDITOR_LENS` 常量
6. 单案例 H1 直接是案例名,无 H2;多案例 H1 是期号,每案 H2 是案例名

Key design points to preserve when modifying:

- **Scoring 走子进程,Drafting 不走**:`lib/score.js` `spawn('claude', [...])` 跑 Haiku
  (`--bare --no-session-persistence` 防止 scorer 自己的会话被 hook 递归索引)。
  `lib/draft.js` **不**起子进程,**也不再有 prompt 模板** — 它只 export 四样裸物料:
  `AUDITOR_LENS`(**内容审计**,7 条探针文本)、`AI_TELLS`(**形式审计**,6 类 LLM
  结构性 tell,来自 Wikipedia "Signs of AI writing")、`titleToSlug`、`extractTitle`。
  整个起草工作流(取证 → 采访 → 终稿)由 `commands/ai-practice-pick.md` 描述,
  主 Claude 在自己的上下文里 agent 化驱动 — 写之前 Read 两份 lens 进上下文。好处:复用主会话的鉴权 + 1M context,不走 Anthropic 的
  "长上下文 Extra Usage"计费档(否则 429)。不要把这种"主对话直起草"再退回 `claude -p`,
  也不要把 prompt 模板加回来 — 主 Claude 已经能基于步描述直接产出。
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
- **Score parse retry**: `lib/score.js#scoreCard` retries once on JSON parse error
  only (not on timeout/crash) — Haiku occasionally ignores the schema. SYSTEM is
  deliberately strict ("第一个字符必须是 `{`"); don't soften it.
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

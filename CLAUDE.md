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
# Run full test suite (83 tests, node --test, zero deps)
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

**起草流程完全在主对话内 agent 化驱动**(不 spawn `claude -p`,不再有 prompt 模板,不再有内容审计探针,也不再有 AI 味形式自检):
1. slash command(`commands/ai-practice-pick.md`)按步描述工作流,主 Claude 用自己的工具
   (Read / Bash / grep / jq)按需取证,边看边判断"够了"就停
2. **5a 采访补证据**:主 Claude 出 1-3 道题(LLM 看不出的事:动机、真实 ROI、备选方案、复用面),
   一次 `AskUserQuestion`(API 上限 4)收完
3. **5b 大纲来源(强烈建议用户自带)**:一次 `AskUserQuestion` 二选一 — "我自己写大纲 (强烈推荐)" /
   "让 Claude 先草一份"。AI 不会读心术,用户自己写 3-5 条 bullet 比 Claude 猜半天值。
   选自带就结束当前 slash command 轮,用户下条消息发大纲后主对话续上 5d。选 Claude 草就进 5c
4. **5c Claude 起草+确认(仅 5b 选了 Claude 草时)**:Claude 出大纲后一次 `AskUserQuestion`
   二选一(采纳/微调)
5. **5d 段落起草**:先把短 `STYLE_GUIDE`(3-8 行,只指方向)读进上下文,然后按大纲一行写一段,
   每段 3-6 句
6. **5e/5f Peterson 修订**:一遍砍句、一遍砍段+重排。原话"试着删掉每一句,不出问题就删"
7. **5g 反推大纲 sanity check**:从修剪后的版本反推主题句,跟原大纲对比;差异大且事后大纲松散
   就**回 5e/5f 循环到通过**。一次过把事情做对 — 落盘的是最终版本,不假设用户会 review
8. **5h 落盘**:`titleToSlug` 拼 `<期号>-<slug>.md`,`Write` 写到 `~/.ai-best-practice/weekly/`
9. 单案例 H1 直接是案例名,无 H2;多案例 H1 是期号,每案 H2 是案例名

**为什么换成 Peterson 写作流程 + 短 STYLE_GUIDE**:这块经历了三轮控制起草质量的尝试 ——
**v1** 用 AUDITOR_LENS(7 条内容审计探针)+ 写作结构模板让草稿读起来像"很懂规范的 AI 写的",
约束本身就是均值化锚点。
**v2** 改成摸用户语气画像(从历史 jsonl 采用户真实发言)+ AI_TELLS(Wikipedia "Signs of AI
writing" 6 类形式 tell 密度自检)。仍然不像用户写的 —— 因为聊天和写作是两种语域,采样聊天画
出的画像本身错位;而且 AI_TELLS 是事后形式补救,救不了结构性的 AI 思考方式(从大纲到段落到
收尾,整体气质是 LLM 的)。
**v3(当前)** 改用 Jordan Peterson 的 Essay Writing Guide(大纲先行 → 段落 → 砍句 → 砍段
→ 反推大纲做 sanity check),通过预设结构和修剪让作者真正想清楚。语域只剩一份**短**
`STYLE_GUIDE`(3-8 行,只指方向,不列规则)。一旦在 STYLE_GUIDE 里列具体 do/don't 或贴示例
就退化回 v1/v2 失败模式 —— 规则本身变成均值化锚点。`test/draft.test.js` 锁了行数上限。

Key design points to preserve when modifying:

- **Scoring 走子进程,Drafting 不走**:`lib/score.js` `spawn('claude', [...])` 跑 Haiku
  (`--bare --no-session-persistence` 防止 scorer 自己的会话被 hook 递归索引)。
  `lib/draft.js` **不**起子进程,**不再有 prompt 模板**,**不再有内容审计探针**,
  **也不再有 AI 味形式自检** — 它只 export 三样裸物料:`STYLE_GUIDE`(短风格方向锚,
  3-8 行,只指方向不列规则)、`titleToSlug`、`extractTitle`。
  整个起草工作流(取证 → 采访 → 大纲 → 段落 → 砍句 → 砍段 → 反推大纲 → 落盘)由
  `commands/ai-practice-pick.md` 描述,主 Claude 在自己的上下文里 agent 化驱动 —
  按 Jordan Peterson Essay Writing Guide 的步骤走,起草段落前读一次 STYLE_GUIDE。
  好处:复用主会话的鉴权 + 1M context,不走 Anthropic 的"长上下文 Extra Usage"
  计费档(否则 429)。不要把"主对话直起草"再退回 `claude -p`,也不要把 AUDITOR_LENS /
  AI_TELLS / 摸语气画像 加回来 — 它们都已被证实是均值化锚点(见 lib/draft.js 头注的演化史)。
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

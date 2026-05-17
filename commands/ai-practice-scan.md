---
description: "扫描 Claude Code 历史会话,调 Haiku 评分入库。默认全量带缓存,接受自然语言参数。"
argument-hint: "可选自然语言,如:本周 / 最近 7 天 / 重新评分 / 不限"
allowed-tools: [Bash, AskUserQuestion, TaskOutput]
---

# ai-practice-scan

把 `~/.claude/projects/` 下的会话评分入库到 `~/.ai-best-practice/data/index.jsonl`(可用 `AIBP_DATA_DIR` 覆盖根目录)。

默认无参数 = 全量 + 带缓存(`jsonlMtime` 未变跳过)。

## 步 0 — 解析参数

- 时间词 → `--recent Nd` 或 `--since YYYY-MM-DD`
- "重新评分" 类 → `--rescore`
- 无范围 → 不加时间参数
- 叠加(如"重新评分最近 7 天")→ `--rescore --recent 7d`

下面用 `$FLAGS`。

## 步 1 — Preflight 计数

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --count-only $FLAGS
```

返回 JSON:`{candidates, alreadyScored, newToScore, concurrency, indexSize}`。`newToScore` 决定成本。

## 步 2 — 粗估 + 决定是否标定

- `newToScore == 0` → 跳到步 4
- `newToScore < 10` → 跳到步 4,粗估报给用户
- `newToScore >= 10` → 走步 3

粗估上限(`N = newToScore`、`C = concurrency`):
- 成本 `≈ N × $0.02`(启发式预筛会压更低)
- 时间:`N >= C` → `N × 17s` 摊销;否则 `~60s`

报告:`本机有 N 条需要评分,粗估上限 $A、约 M 分钟,先标定 10 条拿真实数字`。

## 步 3 — 标定批

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --limit 10 $FLAGS
```

抓 `[scan] done` 字段:`cost`、`elapsed_sec`、`avg_cost`、`avg_sec`、`ok`、`heuristic`。

外推剩余 `(newToScore - 10)` 条:
- 启发式命中率 `h = K / 10`
- 剩余 Haiku 调用数 `≈ (newToScore - 10) × (1 - h)`
- 剩余总花费 `≈ avg_cost × (newToScore - 10) × (1 - h) + 这次的 cost`
- 剩余墙钟:以"剩余 Haiku 调用数"为新 N 套步 2 公式(实测 `avg_sec × concurrency` 替换 17)

汇总给用户。

## 步 4 — AskUserQuestion 拍板

`question`:`已标定 10 条,实测 $X、Y 秒。剩余 N 条预计 $A–B、Z 分钟,继续吗?`

- Option 1(推荐):`继续跑完`
- Option 2:`先停,只要这 10 条就够` — 不跑步 5
- Option 3:`降并发到 2 再跑` — 告诉用户重跑 `AIBP_CONCURRENCY=2 /ai-practice-scan ...`

`newToScore < 10` 时直接用粗估问。

## 步 5 — 全量跑(后台 + 轮询)

1. `Bash(command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js $FLAGS", run_in_background: true)`,拿 `task_id`
2. 循环 `TaskOutput(task_id, block: true, timeout: 30000)`,抓最新 `[scan] heartbeat` 行,翻一行简短中文进度发给用户(例:`进度 25/198(ok 24 / cached 0 / error 1)| 已花 $0.42 | 剩余约 4.2m`),出现 `[scan] done` 跳出
3. 每轮一行总结,不回显 stdout 全文

步 3 入库的 10 条会命中 mtime 缓存自动跳过。

## 步 6 — 终态报告

汇总 `[scan] done` 字段:总数 / ok / heuristic / cached / skipped / error / 重试次数、累计 cost、墙钟、`index.jsonl` 当前条数(`wc -l`)、失败日志路径 `~/.ai-best-practice/logs/ai-best-practice.log`。

## 内部 flag

| flag | 含义 |
|---|---|
| 无 | 全部 jsonl,带缓存 |
| `--count-only` | 干跑,JSON 计数 |
| `--rescore` | 忽略缓存重评 |
| `--recent 7d` | 最近 N 天(`d`/`w`/`m`) |
| `--since 2026-05-01` | 起始日期 |
| `--limit 10` | 仅前 N 条 |

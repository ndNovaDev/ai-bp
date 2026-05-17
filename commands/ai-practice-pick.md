---
description: "从已索引的 AI 会话里挑案例并生成中文 OKR 周报。接受自然语言过滤条件。"
argument-hint: "可选自然语言,如:本周 / 最近 3 天 / 上个月关于自动化的 / 不限"
allowed-tools: [Bash, Read, Write, AskUserQuestion]
---

# ai-practice-pick

## 步 0 — 自然语言 → flag

| 用户说 | flag |
|---|---|
| 本周 / 这周 | `--this-week` |
| 上周 | `--last-week` |
| 最近 N 天 | `--recent Nd` |
| 上个月 / 上月 | `--last-month` |
| 本月 | `--this-month` |
| 2026-05 / 5 月 | `--month 2026-05` |
| 自 5 月 1 日以来 | `--since 2026-05-01` |
| 关于 X 的 / X 相关 | `--tag X` |
| 高分的 | `--min-score 80` |
| 前 N 条 | `--top N` |
| 不限 / 全部 | `--full` |
| 空 / 默认 | 无参数(全周期 score≥60 top 30) |

可叠加。下面用 `$FLAGS` 代指拼出来的串。

## 步 0.5 — 兜底 scan

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --recent 14d
```

报错或超时无碍。不向用户解释。

## 步 1 — 拉候选

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/list.js $FLAGS
```

返回按 score 倒序的 JSON 数组。空数组 → 告诉用户"无候选,可放宽过滤或先 `/ai-practice-scan`",结束。

## 步 2 — 聚类 + 排名

下一条回复里贴 fenced JSON。同一件事的多个 session 合到一个 topic(信号:summary / tags / cwd / highlights 组合,同 cwd 不等于同 topic)。按"作为 OKR 周报案例的合适度"排 rank,保留前 8。

```json
{
  "topics": [
    {
      "title": "8-20 字事件名",
      "sessionIds": ["..."],
      "primarySessionId": "...",
      "rank": 1,
      "reason": "≤30 字:聚合理由 + 排序理由"
    }
  ]
}
```

## 步 3 — 用户挑 topic

`AskUserQuestion`(`multiSelect: true`),top 4:

- `label`: `[最高分 N|涵盖 M session] <title>`
- `description`: AI 的 `reason` + 日期跨度

用户勾 1-3 个。

## 步 4 — 取证(逐 topic)

按顺序取,够下笔就停。**core 是前两步,后两步是核对/补刀。**

1. **元数据**:`~/.ai-best-practice/data/index.jsonl` grep sessionIds,合 tags / filesEdited / 时间窗。框定 scope。
2. **user 消息原文**(主证据 — 用户的真实意图 / 卡点 / 转折):
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/parse-jsonl.js --user-turns <jsonl-path>
   ```
   jsonl 路径在 index.jsonl 行的 `jsonlPath` 字段。输出按时间序的 `[ts]\n<text>\n---\n` 块,体量小(几十 KB 级)。这是周报唯一没被 Haiku 摘要过滤掉的"人话",assistant 输出不抽 — 那部分已经在 git 里物化。如需控量,加 `--max-chars 400`。
3. **git**(核对"做了什么" — 是否真落地):进 cwd,`git log --since=<起> --until=<止> --oneline`,关键 1-3 commit 跑 `git show --stat <hash>`,需要 patch 时只看怀疑的那个文件 `git show <hash> -- <file>`
4. **artifact**(补刀 patch 细节):filesEdited 挑 1-3 个,`Read` 加 offset/limit,一次 ≤ 200 行

**严禁**直接拿 index.jsonl 里 Haiku 生成的 `summary` / `highlights` 当起草素材 —— 那是二手压缩,起草锚到它就是在抄摘要,正是历代 reviewer 失败的根因(见 `scripts/lib/draft.js` 头注)。`summary` / `tags` 只用于步 2 聚类、步 3 选题。

## 步 5 — 起草 + 落盘

直接写。落盘路径:

```bash
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<案例名 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
```

`WEEK_PREFIX` 没 ISO 周时退回 `recent-Nd`。`Write` 落盘到 `~/.ai-best-practice/weekly/<期号>-<slug>.md`。

多 topic:一篇 markdown,H1 是期号,每 topic 一个 H2。

## 步 6 — 报告

- 输出文件路径
- 未选 topic 列表,每条标涵盖几 session

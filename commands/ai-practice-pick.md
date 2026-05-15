---
description: "从已索引的 AI 会话里挑案例并生成中文 OKR 周报草稿。接受自然语言过滤条件。"
argument-hint: "可选自然语言,如:本周 / 最近 3 天 / 上个月关于自动化的 / 不限"
allowed-tools: [Bash, Read, Write, AskUserQuestion]
---

# ai-practice-pick

把"找素材 + 写作文"全流程串起来。**默认全周期高分**;过滤条件用自然语言传。

## 你(Claude)收到的参数

`$ARGUMENTS` 是用户的**自然语言**,例如:
- "本周" / "这周" / "最近一周"
- "最近三天" / "近 3 天" / "过去 72 小时"
- "上个月" / "5 月份关于自动化的"
- "高分的最近 10 条"
- "" 或 "默认" — 全周期 score≥60 top 30

## 工作流(严格按顺序执行)

### 步 0 — 解析自然语言为脚本 flag

你自己想清楚(无需调 LLM),把用户输入转成下表里的 flag 组合:

| 用户说 | 你解析为 |
|---|---|
| 本周 / 这周 | `--this-week` |
| 上周 | `--last-week` |
| 最近 N 天 | `--recent Nd` |
| 上个月 / 上月 | `--last-month` |
| 本月 | `--this-month` |
| 2026-05 / 5 月 | `--month 2026-05` |
| 自 5 月 1 日以来 | `--since 2026-05-01` |
| 关于 X 的 / X 相关 | `--tag X`(X 取自 automation/refactor/debug/meta/integration/design/docs/infra/data/learning 等) |
| 高分的 | `--min-score 80` |
| 前 N 条 | `--top N` |

多意图叠加,例如"上个月关于自动化的高分 5 条" → `--last-month --tag automation --min-score 80 --top 5`。

### 步 1 — 拉候选粗排

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/list.js <你解析出的 flag>
```

返回 JSON 数组(按 score 降序的前 N 条)。空数组 → 告知用户"无候选,可能需要先 `/ai-practice-scan` 或放宽过滤",停止。

### 步 2 — AI 二次排序

把候选精简字段(date / score / summary / tags)pipe 给 `claude -p`,要求按
"作为 OKR 周报案例的合适度"重排,理由考虑时效、tag 多样性、故事完整度:

```bash
echo "$LIST_JSON" | claude -p --bare --no-session-persistence \
  --permission-mode bypassPermissions --model claude-haiku-4-5 \
  --output-format json \
  --json-schema '{"type":"array","items":{"type":"object","required":["sessionId","rank","reason"],"properties":{"sessionId":{"type":"string"},"rank":{"type":"integer"},"reason":{"type":"string"}}}}' \
  --append-system-prompt '只输出 JSON 数组,无其他文字'
```

读 `structured_output`,排序后只保留 top 10。失败就降级到 score 排序。

### 步 3 — 用户挑选

用 **AskUserQuestion** (`multiSelect: true`) 把 top 10 呈现:
- label: `[88] 2026-05-13 用 hook 索引 AI 会话(automation, meta)`
- description: 完整 summary
- 用户勾 1-3 条

如果 top 10 太多塞不下 AskUserQuestion 的 4 选项上限,**分页**:先显示前 4 条让用户挑或翻页。

### 步 4 — 组装证据包

对勾选的每个 sessionId,组装一个 `evidencePack` JSON,后面起草要用:
- 从 `index.jsonl` 拿 `jsonlPath` / `cwd` / `tools` / `skills` / `mcpServers` / `filesEdited` / `summary` / `highlights` / `tags` / `score`
- **Read 原始 jsonl 头 80 行 + 尾 80 行**(整文件不要塞进主对话)
- 在该 session 的 `cwd` 下跑 `git log --oneline -20`(若是 git 仓库,失败就跳过)
- 对 `filesEdited` 取前 8 个,跑 `git log --oneline -3 -- <file>` 拿最近 3 条 commit 主题(可选)

把以上塞进一个对象:
```json
{
  "sessionId": "...",
  "cwd": "...",
  "rangeLabel": "...",
  "score": 80,
  "summary": "...",
  "highlights": [...],
  "tags": [...],
  "tools": {...},
  "skills": [...],
  "mcpServers": [...],
  "filesEdited": [...],
  "filesRecentCommits": { "/path/file.js": ["c027a71 ...", "..."] },
  "gitLog": ["c027a71 ...", "..."],
  "jsonlHead": "前 80 行原文",
  "jsonlTail": "末 80 行原文"
}
```

多案例就组装一个数组,每条都是上述结构。

### 步 5 — 起草:两阶段 + 一轮采访(**在主对话内做,不 spawn `claude -p`**)

起草不再起子进程。你(主对话的 Claude)就是写作 LLM:`lib/draft.js` 只给你提供
**提示词模板字符串**,你拿到字符串后,在自己的下一次回复里产出 STAR / markdown。
好处:省了 1M context 子进程的 Extra Usage 计费,也省一次模型冷启动。

整套服务一个假想敌:公司内部的"AI 最佳实践审计 AI",它的 7 条探针已经写在
`lib/draft.js::AUDITOR_LENS`,会自动内嵌进每条 prompt,你不用单独想。

#### 5a — 出初稿和 4 道采访题(单案例)

对**每个**选中的 sessionId,先把 evidencePack 落到临时文件(JSON 里有特殊字符,heredoc 拼接易出错),
再用 node 拼出 probe prompt 字符串:

```bash
# 1) 写 evidencePack 到 tmp(用 Write 工具或 cat heredoc 都行)
EVID=$(mktemp -t aibp-evid.XXXXXX.json)
# ... 用 Write 工具把 evidencePack JSON 写到 $EVID ...

# 2) 拿到要应用的 prompt 文本
RANGE_LABEL='2026-W20' node -e '
const fs = require("fs");
const { buildProbePrompt } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const evidencePack = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(buildProbePrompt({ rangeLabel: process.env.RANGE_LABEL, evidencePack }));
' "$EVID"
```

Bash 输出的就是给你看的 probe prompt(已内嵌 AUDITOR_LENS、证据包 JSON 和形状要求)。
**你的下一条回复**要按那个 prompt 的形状产出严格 JSON:

```json
{
  "proposedTitle": "会话评分流水线工程化",
  "draftSTAR": { "situation": "...", "task": "...", "action": "...", "result": "..." },
  "questions": [
    { "module": "S", "prompt": "本次最痛的痛点是什么?",
      "options": ["每周手动翻历史耗时", "周报内容主观难复用", "想试 Claude Code 的 hook 能力"] },
    { "module": "T", "prompt": "...", "options": [...] },
    { "module": "A", "prompt": "...", "options": [...] },
    { "module": "R", "prompt": "...", "options": [...] }
  ]
}
```

无需写到磁盘 — JSON 内容直接保留在你的上下文里,下一步用就行。

#### 5b — 采访用户(**一次** AskUserQuestion,批量 4 题)

把上一步产出的 4 道 question **打包到同一次** `AskUserQuestion` 调用(API 的 `questions` 数组上限刚好 4)。
组装方式:

```
AskUserQuestion(
  questions: [
    {
      question: <questions[0].prompt>,
      header: '背景',
      multiSelect: false,
      options: [
        { label: <questions[0].options[0]> + ' (推荐)', description: 'LLM 基于证据的最佳猜测' },
        { label: <questions[0].options[1]>, description: '' },
        { label: <questions[0].options[2]>, description: '' } // 若有
      ]
    },
    { ...questions[1] header='目标'... },
    { ...questions[2] header='做法'... },
    { ...questions[3] header='结果'... }
  ]
)
```

`header` 按 module 翻译:`S → 背景`、`T → 目标`、`A → 做法`、`R → 结果`。

收集 answers 数组:`[{module, prompt, answer}]`,严格按 questions 原顺序。用户走 Other 或跳过的 answer 就 `null`。
**多案例**:对每条 sessionId 各做一次 5a + 一次 5b(每案 1 屏 4 题),不要把多案例的题混到一屏。

#### 5c — 最终定稿(主对话产出,Write 落盘)

```bash
# 1) 把"finalize 输入"写到 tmp:{rangeLabel, evidencePack, drafts, answers, hasMultipleCases}
FIN=$(mktemp -t aibp-fin.XXXXXX.json)
# ... 用 Write 工具把上述对象 JSON 写到 $FIN ...

# 2) 拿到要应用的 finalize prompt 文本
node -e '
const fs = require("fs");
const { buildFinalizePrompt } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(buildFinalizePrompt(payload));
' "$FIN"
```

Bash 输出的就是 finalize prompt(已内嵌 AUDITOR_LENS、证据包、初稿、用户答复、结构与写作规则)。
**你的下一条回复**:直接产出最终 markdown 正文(无围栏、无前言),然后用 `Write` 工具落盘:

```bash
# 拿到落盘路径:WEEKLY_DIR/<WEEK_PREFIX>-<slug>.md
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<proposedTitle 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
```

`WEEK_PREFIX` 形如 `2026-W20`(直接取自时间范围,没 ISO 周时用 `recent-3d` 这种)。

#### 5d — 后置检测禁用短语,命中则重写一次

落盘后跑 `detectBanned`:

```bash
node -e '
const fs = require("fs");
const { detectBanned } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const md = fs.readFileSync(process.argv[1], "utf8");
console.log(JSON.stringify(detectBanned(md)));
' "$OUT_PATH"
```

输出是命中的禁用词数组。**空数组就完成了**。非空则:
- 重新拼 finalize prompt,这次给 `buildFinalizePrompt` 多传一个 `bannedHits: [...]`,
  它会在 prompt 末尾追加"重写要求"段
- 你应用新 prompt,**重写一次** markdown,Write 覆盖原文件
- 不管第二次还命不命中,**只重写一次**,接受现状

#### 5e — 多案例情况

如果用户在步 3 勾了 ≥ 2 条 session:先对每条 session 跑完 5a + 5b(每案 1 屏 4 题),
然后**一次** 5c,传 `hasMultipleCases: true`,`evidencePack` 是数组,`drafts` 也是数组,
`answers` 把多案的拼起来(每条 answer 加 `case: <idx>` 或前缀进 prompt 区分都行,
finalize prompt 自己会处理顺序)。`buildFinalizePrompt` 会输出 H1=期号、每案 H2=案例名 的多案版式。

单案例(勾 1 条)→ `hasMultipleCases: false`,H1 直接是案例名,无 H2。

### 步 6 — 报告

- 输出文件路径
- 是否触发了禁用短语重写(5d 命中过就提一下"已重写一次")
- 未选中的候选(下次可用)
- 提示用户:**这是初稿,审计 AI 探针只是设计假想敌,真审稿要靠人**。检阅后再提交。

周报落在 `~/.ai-best-practice/weekly/`(可用 `AIBP_DATA_DIR` 覆盖),
不在插件目录里,插件升级不会丢历史草稿。

**关于成本**:起草现在在主对话进行,所以不再单独报"起草 cost" — 它直接计入你这个主会话的 token 用量。
如果用户问,可以告诉他:"草稿在当前对话里写的,没有起子进程,token 用量看 `/cost`"。

## 内部脚本支持的 flag(供你拼接)

| flag | 含义 |
|---|---|
| 无参数 | 全周期 score≥60 top 30 |
| `--this-week` / `--last-week` | 本/上 ISO 周 |
| `--this-month` / `--last-month` | 本/上月 |
| `--today` / `--yesterday` | 今/昨 |
| `--recent 7d` | 最近 N 天(d/w/m) |
| `--week 2026-W20` | 指定 ISO 周 |
| `--month 2026-05` | 指定月 |
| `--since YYYY-MM-DD` `--until YYYY-MM-DD` | 自定义区间 |
| `--tag X` | 按 tag 过滤 |
| `--min-score 70` | score 下限(默认 60) |
| `--top N` | 取前 N(默认 30) |
| `--full` | 不限 min-score |

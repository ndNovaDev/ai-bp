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

### 步 2 — 你(主 Claude)自己聚类 + 重排

**不开子进程,不调 Haiku**。步 1 输出的候选 JSON 顶多几十 KB,你直接读进上下文,
在下一条回复里产出一个 fenced JSON code block — 同时做两件事:

1. **聚类**:把同一件事的多个 session 合成一个 topic。
   信号综合看 summary/tags/cwd/highlights — 不要硬编码"同 cwd 即同 topic"
   (同仓库的不同 feature 应分开;不同仓库的同类工具迭代反而该合)。
   为什么聚类:用户视角里"一件事"才是一等公民。比如 ai-best-practice 工具自身的 4 次迭代 session,
   应该合成一个 topic 让用户挑,而不是把 4 个高度相似的候选都摆出来。
2. **排序**:按"作为 OKR 周报案例的合适度"给 topic 排名(rank=1 最好),
   理由考虑时效、tag 多样性、故事完整度、产物可分发性。

形状(在你的回复里贴出来,后续步骤直接引用):

\`\`\`json
{
  "topics": [
    {
      "title": "企业级 AI 评分系统四层架构",
      "sessionIds": ["abc-123", "def-456", "..."],
      "primarySessionId": "abc-123",
      "rank": 1,
      "reason": "工具四次迭代收口为一个 plugin,产物完整可分发"
    }
  ]
}
\`\`\`

要求:
- title 8-20 字,概括"这件事"而非某次会话。
- primarySessionId 选信息最完整 / score 最高的那条。
- reason ≤ 30 字,聚合理由 + 排序理由各一句。
- 按 rank 升序保留前 8 个 topic;明显独立的事不要硬塞一起。

为什么不调 Haiku:步 5 起草已经在主对话内做,步 2 也是纯 JSON→JSON 判断,
没必要再走一次 \`claude -p\` 子进程(子进程那条路有 schema 校验坑、1M context 计费档、冷启动)。
省一次冷启动 + 省一次实金 + 你的判断比 Haiku 强。

### 步 3 — 用户挑 topic

用 **AskUserQuestion** (`multiSelect: true`) 把 top topic 呈现:
- label: `[最高分 88|涵盖 4 session] 企业级 AI 评分系统四层架构`
  - 最高分取 topic 内 max(session.score),session 数取 sessionIds.length
- description: AI 的 reason(聚合理由 + 排序理由)+ 一句涵盖范围(日期跨度)
- 用户勾 1-3 个 topic

AskUserQuestion 的 options 上限是 4,所以一屏只能展示 top 4 topic。如果用户都不满意,再展示下一屏(5-8)。
**不要**把同一个 topic 里的多个 sessionId 拆成多个选项 — 那就是这次重构的反面。

### 步 4 — 组装 topic 级证据包(产物驱动,不是会话驱动)

对勾选的每个 topic,把它涵盖的所有 sessionId 合并成**一份事件档案**。证据包结构:

```json
{
  "topicTitle": "企业级 AI 评分系统四层架构",
  "rangeLabel": "2026-W20",
  "sessionIds": ["abc-123", "def-456", "..."],
  "primarySessionId": "abc-123",
  "cwds": ["/Users/lqy/tyc/ai-best-practice"],
  "score": { "max": 88, "avg": 85 },
  "tags": ["...合并去重..."],
  "tools": { "Bash": 42, "Edit": 30 },
  "skills": ["..."],
  "mcpServers": ["..."],

  "sessionTimeline": [
    { "sessionId": "abc-123", "endedAt": "2026-05-13T...", "score": 88, "highlight": "搭起 hook + 评分骨架" },
    { "sessionId": "def-456", "endedAt": "2026-05-14T...", "score": 85, "highlight": "加 mtime cache 省 token" }
  ],

  "gitLog": ["c027a71 ...", "..."],
  "gitDiffStat": "X files changed, Y insertions(+), Z deletions(-)",
  "gitKeyCommits": [
    { "hash": "c027a71", "subject": "...", "diff": "前 ~200 行 patch" }
  ],

  "filesEdited": ["...合并去重后的完整列表..."],
  "keyArtifacts": [
    { "path": "scripts/lib/draft.js", "content": "<= 300 行原文(超长截 head/tail)" }
  ],

  "jsonlExcerpts": [
    { "sessionId": "abc-123", "head": "前 40 行", "tail": "末 40 行" }
  ]
}
```

组装步骤:

1. **合并 session 元数据**:遍历 topic.sessionIds,从 `index.jsonl` 拉每行,合并去重 `tags` / `skills` / `mcpServers` / `filesEdited`;`tools` 计数相加;`score.max` / `score.avg` 算一下;`cwds` 去重(通常只有 1 个)。

2. **sessionTimeline**:每条 session 一行,带 `endedAt` 和一句 highlight(取 session 的 `highlights[0]`)。按时间升序。

3. **gitLog + gitDiffStat**:在第一个 `cwd` 下,确定时间窗口 `[min(startedAt), max(endedAt)]`,跑:
   ```bash
   git log --since=<起> --until=<止> --oneline    # → gitLog
   git diff --stat <first_hash>^..<last_hash>    # → gitDiffStat
   ```
   失败(非 git 仓 / 空范围)就跳过这块。

4. **gitKeyCommits**:从 gitLog 里挑 top 3 个最相关的 commit(commit message 跟 topic 标题/tags 沾边的优先),每个跑 `git show --stat --patch <hash>`,patch 截到 **200 行** 以内。总 diff 不超过 **1500 行**;超了就只保留前 2 个 commit。

5. **keyArtifacts**:从合并后的 `filesEdited` 里挑 top **5 个**(优先 .md / .js / .ts / .py 等代码文件;跳过 lock / node_modules / build 产物);每个文件 `Read` 完整内容,超过 **300 行**就头 150 + 尾 150 拼起来,中间插 `\n// ... <truncated N lines> ...\n`。文件不存在(被删了)就跳过。

6. **jsonlExcerpts**:每个 sessionId 读头 **40 行 + 尾 40 行**(比单 session 时的 80+80 少一半,因为现在可能有多个)。

如果用户勾了多个 topic,组装一个 evidencePack **数组**,每条都是上述结构。

### 步 5 — 起草:两阶段 + 一轮采访(**在主对话内做,不 spawn `claude -p`**)

起草不再起子进程。你(主对话的 Claude)就是写作 LLM:`lib/draft.js` 只给你提供
**提示词模板字符串**,你拿到字符串后,在自己的下一次回复里产出 STAR / markdown。
好处:省了 1M context 子进程的 Extra Usage 计费,也省一次模型冷启动。

整套服务一个假想敌:公司内部的"AI 最佳实践审计 AI",它的 7 条探针已经写在
`lib/draft.js::AUDITOR_LENS`,会自动内嵌进每条 prompt,你不用单独想。

#### 5a — 出初稿和 4 道采访题(按 topic)

对**每个**选中的 topic,先把它的 evidencePack(步 4 组装的事件档案)落到临时文件
(JSON 里有特殊字符,heredoc 拼接易出错),再用 node 拼出 probe prompt 字符串:

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
**多 topic**:对每个 topic 各做一次 5a + 一次 5b(**每个 topic 1 屏 4 题**,不是每个 session 1 屏)。
即便 topic 涵盖 4 个 session,也只问一次 4 题 — 这就是聚类的意义。

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

#### 5e — 多 topic 情况

如果用户在步 3 勾了 ≥ 2 个 topic:先对每个 topic 跑完 5a + 5b(每 topic 1 屏 4 题),
然后**一次** 5c,传 `hasMultipleCases: true`,`evidencePack` 是数组(每条是一个 topic 的事件档案),
`drafts` 也是数组,`answers` 把多 topic 的拼起来(每条 answer 加 `case: <idx>` 或前缀进 prompt 区分都行,
finalize prompt 自己会处理顺序)。`buildFinalizePrompt` 会输出 H1=期号、每个 topic H2=案例名 的多案版式。

单 topic(勾 1 个)→ `hasMultipleCases: false`,H1 直接是 topic 标题,无 H2。
(注意:单 topic 但涵盖多 session,仍是 `hasMultipleCases: false` — 这是一件事,不是多件事。)

### 步 6 — 报告

- 输出文件路径
- 是否触发了禁用短语重写(5d 命中过就提一下"已重写一次")
- 未选中的 topic(下次可用),每条标一下涵盖几个 session
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

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

### 步 4 — 你(主 Claude)自己取证

**不要预先组装一份大 JSON 证据包再喂给自己** — 那是旧设计的遗留,会让一份 80-150KB 的证据原样进 prompt
两次(probe + finalize),又慢又烧 token。

改成 agent workflow:对**每个**选中的 topic,你拿着 topic.sessionIds 和元数据,
**用你自己的工具按需收集证据,边看边判断"够了"就停**。叙事对象是事件,产物 > 对话。

下面是你应该考虑的取证清单(不是必须按顺序、不是必须全跑;根据 topic 性质自己挑):

- **session 元数据**:从 `~/.ai-best-practice/data/index.jsonl` 把 topic.sessionIds 对应的行 grep 出来,合并 tags / tools / skills / mcpServers / filesEdited,推算时间窗 `[min(startedAt), max(endedAt)]`。
- **git 证据(优先级最高)**:进入 session 的 cwd,跑 `git log --since=<起> --until=<止> --oneline`;挑跟 topic 标题/tags 最相关的 1-3 个 commit 跑 `git show --stat <hash>` 看变更概览;**只有当 stat 不足以判断意图时**才去 `git show --patch` 看 diff 原文,且只看你怀疑的那个文件(`git show <hash> -- <file>`),不要拉整个 patch。
- **artifact 原文**:从合并后的 filesEdited 挑 1-3 个最能说明问题的文件(.md / 关键代码),`Read` 看 — 限制每次 ≤ 200 行(用 offset/limit 参数,不要读整文件);看够就停。
- **对话流水**:**默认跳过**。仅当 git + artifact 都没解释清楚作者动机时,才 Read 某个 sessionId 对应的 jsonl 文件头 40 行 + 尾 40 行(用 `head -n 40` + `tail -n 40`)。

判断"够了":你能写出一份经得起 AUDITOR_LENS 7 条探针拷问的 STAR 初稿,就停。不要追求"覆盖所有证据",追求"足够下笔"。

收集过程你**不要**把每个文件原文复述出来,**不要**做信息搬运 — 你的工作记忆里有就行,下一步起草直接用。

多 topic 各自跑一次步 4。

### 步 5 — 起草:采访 + 写作(完全主对话 agent 化)

起草整个工作流由你(主 Claude)亲自驱动。`scripts/lib/draft.js` 提供 `titleToSlug` 算文件名,其余从简。

#### 5a — 出初稿和 4 道采访题(按 topic)

基于步 4 收集到的证据(已在你的工作记忆里),为这个 topic 在**你的下一条回复里**产出一个 fenced JSON。
**不要再 Read / Bash / 取证** — 步 4 已经够了,直接动笔。

形状(必须严格):

\`\`\`json
{
  "proposedTitle": "会话评分流水线工程化",
  "draftSTAR": {
    "situation": "60-180 字,作者当时的处境,问题为什么会冒出来",
    "task":      "60-180 字,作者给自己定的目标 + 隐含约束",
    "action":    "60-180 字,关键动作,叙事化,不堆工具名,跳过琐碎实现",
    "result":    "60-180 字,产物 + 量化或诚实'未量化' + 一句点到未来杠杆"
  },
  "questions": [
    { "module": "S", "prompt": "本次最痛的痛点是什么?",
      "options": ["每周手动翻历史耗时", "周报内容主观难复用", "想试 Claude Code 的 hook 能力"] },
    { "module": "T", "prompt": "...", "options": [...] },
    { "module": "A", "prompt": "...", "options": [...] },
    { "module": "R", "prompt": "...", "options": [...] }
  ]
}
\`\`\`

要求:
- proposedTitle 8-20 字,不含日期/期号/案例编号。
- draftSTAR 四段,每段 60-180 字。证据不足以判断的段写一句 `[需采访:具体缺什么]`,采访题要补的就是这个缺口。
- questions **正好 4 道,按 S→T→A→R 顺序各一道**(slash command 下一步会把这 4 道压到一次 AskUserQuestion,API 上限刚好 4)。
- 每道 options 2-3 个;第一个是基于证据的最佳猜测(用户直接点 = 静默接受),其余是其他合理角度。
- 专问 LLM 看不出的事:动机、痛点强度、被淘汰的备选、真实 ROI、复用面、走过的弯路。不要问从证据里能推出来的事。
- 用户秒懂的口语化中文。
- 叙事对象是"事件"不是"会话"。证据来自多个 sessionId 也只当一件事写。

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

#### 5c — 写最终 markdown

基于步 4 的证据 + 5a 的 STAR 初稿 + 5b 的用户答复(全在你工作记忆里),
**在你的下一条回复里直接产出一份高质量的 AI 实践报告**。结构、字数、写作风格自定。

写完用 `Write` 落盘。文件路径:

```bash
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<proposedTitle 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
```

`WEEK_PREFIX` 形如 `2026-W20`(直接取自时间范围,没 ISO 周时用 `recent-3d` 这种)。

#### 5d — 多 topic 情况

如果用户在步 3 勾了 ≥ 2 个 topic:先对每个 topic 串行跑完 步 4 + 5a + 5b(**每 topic 1 屏 4 题**)。
所有 topic 的 STAR 初稿 + 用户答复都在你工作记忆里之后,**一次** 5c 写一份多 topic 版的 markdown。

单 topic 涵盖多 session 仍按单 topic 处理 — 这是一件事不是多件事,这就是聚类的意义。

### 步 6 — 报告

- 输出文件路径
- 未选中的 topic(下次可用),每条标一下涵盖几个 session
- 提示用户:**这是初稿,检阅后再提交**。

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

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

## 步 5 — 采访(让用户简短给方向,逐 topic)

写之前必须给用户一次开口的机会。Claude 能从证据拼出"你做了什么",但不会读心 —— 不知道你想突出哪条线、想让读者带走什么、想保留或删掉什么。哪怕用户只给一句"重点要 X",都比让 Claude 凭空猜强一大截。

每个 topic 一次 `AskUserQuestion`(`multiSelect: false`)。题目模板:

> **<topic 标题>** — 写之前给我一点方向?选一类,然后在 Other 里填具体内容。可填的东西很广:大纲条目、"重点突出 X"、"删 Y 那段"、"按 1-2-3 顺序写"、"我担心 Y 没讲清楚"、几句话讲清楚整篇要讲什么 —— 都行。

options:

1. **label**: "给个大纲 (推荐)" — **description**: "几行主题句,我按你给的顺序扩写"
2. **label**: "全文简述" — **description**: "几句话讲清楚要写什么、突出什么、避开什么"
3. **label**: "几个关键要点" — **description**: "想强调的、想保留的事实、想删的东西,列几条"
4. **label**: "你自己看着办" — **description**: "我按证据 + 四条方向直接写"

处理规则:

- 用户选 1/2/3 + Other 有内容 → 把 Other 内容当成**主要锚**,带进步 6,优先级高于"四条方向"
- 用户选 1/2/3 + Other 为空 → 当作选 4 处理
- 用户选 4 → 直接进步 6,不强求

不要质疑用户给的方向。哪怕你觉得他漏了某个角度,先按他说的写完第一版,后续他自己会发现并补。

## 步 6 — 写第一版

如果步 5 用户给了方向(大纲 / 简述 / 要点),按用户的方向写,**用户的方向是主线**。下面四条方向在用户没给的地方填空、做兜底。

如果步 5 用户选了"你自己看着办",只按下面四条方向写。

这是第一版,留到步 7 打散后才是最终稿。

四条方向性约束(只指方向,不列规则;v1-v3 历代失败教训:列负面规则等于均值化锚点,见 draft.js 头注):

1. **王小波口吻**。对话感,略带疏离,句式参差。不写金句,不搞对仗,避免 LLM 默认的"首先/其次/总之"和工整排比节奏。粗体小标题之间显式破对仗(不同长度、不同句式、不同人称)。
2. **金字塔原理结构**。第一段把结论 + 收益讲完(读者读到这里就该知道做了什么、值不值)。后面才铺关键判断、撞过的墙、细节。线性时间叙事(起因→决定→实现→踩坑→效果)默认不取。
3. **避免"知识的诅咒"**。任何术语、缩写、自造概念,在它第一次出现的位置之前必须已经能站得住 —— 要么是通识,要么前文铺过。需要某个后定义的术语,把解释往前挪,或把那段叙述往后挪。
4. **读者画像:审稿的 AI + 公司领导**。讲做了什么 + 大致原理 + 价值。技术细节够审计判断真伪就行,不堆细节,不挖实现。

## 步 7 — 句式打散(必做)

步 6 第一版必然带 LLM 默认节奏。这一步把它打散。

逐子句重写。每个逗号 / 句号 / 分号 / 冒号之间的串,**都强制换一遍** —— 长短随机,句式随机,继续按王小波口吻。

**唯一硬性要求:通顺**。"通顺"包含两层:意思不被搞坏 + 读起来不卡。所以"随机长度"是长短分布要均衡,**不是越短越好** —— 堆一堆三五字的短句不叫打散,叫切碎,反而失了通顺。王小波本人写的就是带嵌套从句的长句穿插短句,不是 staccato。

除此之外不设任何约束 —— 不列变换维度,不预设 SOP。

为什么这一条这么短:v3.x 那版给过具体清单("换起头 / 动词 / 修辞 / 句式",外加一条"能从改动里抠出 SOP 就推倒重做"的自指悖论),结果失败了 —— 列了清单,清单本身就是新锚点(见 draft.js 头注)。这次只留"通顺"一条硬约束,变换维度让模型自己随机,降低再次造出锚点的概率。

## 步 8 — 落盘

```bash
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<案例名 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
```

`WEEK_PREFIX` 没 ISO 周时退回 `recent-Nd`。`Write` 落盘到 `~/.ai-best-practice/weekly/<期号>-<slug>.md`。

多 topic:一篇 markdown,H1 是期号,每 topic 一个 H2。所有 topic 都过完步 5 + 步 6 + 步 7 之后再一次性落盘。

## 步 9 — 报告

- 输出文件路径
- 未选 topic 列表,每条标涵盖几 session

---
description: "从已索引的 AI 会话里挑案例并生成中文 OKR 周报。接受自然语言过滤条件。"
argument-hint: "可选自然语言,如:本周 / 最近 3 天 / 上个月关于自动化的 / 不限"
allowed-tools: [Bash, Read, Write, AskUserQuestion]
---

# ai-practice-pick

找素材、写作文,两件事一条流水线。默认是全周期高分;要缩范围,自然语言告诉它即可。

## 你(Claude)收到的参数

`$ARGUMENTS` 透传用户原话。例子:

- "本周" / "这周" / "最近一周"
- "最近三天" / "近 3 天" / "过去 72 小时"
- "上个月" / "5 月份关于自动化的"
- "高分的最近 10 条"
- "" 或 "默认" — 全周期 score≥60 top 30

## 工作流(严格按顺序执行)

### 步 0 — 解析自然语言为脚本 flag

查表即可。无需 LLM。

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

意图可叠加。"上个月关于自动化的高分 5 条"拼出来就是 `--last-month --tag automation --min-score 80 --top 5`。

### 步 0.5 — 静默 scan 兜底(必跑)

hook 不可靠。关窗、`/exit`、强杀都会让 SessionEnd 漏掉。因此 pick 一开始先把最近 14 天静默扫一遍,漏网的 session 顺手补上索引。mtime cache 在,扫到旧条目直接跳过,几乎不花钱。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --recent 14d
```

正常半分钟内跑完。新 session 多就久一点。报错或超时无碍,索引主体还在,继续步 1。这一步不向用户解释。

### 步 1 — 拉候选粗排

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/list.js <你解析出的 flag>
```

脚本回一个 JSON 数组,按 score 倒序,前 N 条。空数组意味着没有候选;告诉用户"无候选,可能需要先 `/ai-practice-scan` 或放宽过滤",到此为止。

### 步 2 — 你(主 Claude)自己聚类 + 重排

不开子进程,不调 Haiku。候选 JSON 顶多几十 KB,塞进上下文绰绰有余。下一条回复里贴一个 fenced JSON code block,顺手完成两件事。

**聚类**。同一件事的多个 session 合并到一个 topic 里。判断信号来自 summary、tags、cwd、highlights 的组合,不能硬编码"同 cwd 即同 topic"。同仓库的不同 feature 必须分开;反过来,不同仓库的同类工具迭代倒是该合。为什么聚类?用户视角里"一件事"才是一等公民。举例:这个工具自身的 4 次迭代会话,合成一个 topic 让用户挑,远比把 4 条高度相似的候选都摆出来要好。

**排序**。按"作为 OKR 周报案例的合适度"给 topic 排名,rank=1 最好。打分时综合时效、tag 多样性、故事完整度、产物可分发性。

输出形状如下,后续步骤直接引用:

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

具体要求:

- title 8-20 字,描述事件,不是某次会话。
- primarySessionId 选信息最完整或 score 最高的那条。
- reason 不超过 30 字,聚合理由一句、排序理由一句。
- 按 rank 升序,保留前 8 个。明显独立的事项不要硬塞一起。

### 步 3 — 用户挑 topic

通过 **AskUserQuestion**(`multiSelect: true`)呈现 top topic。

- label 形如 `[最高分 88|涵盖 4 session] 企业级 AI 评分系统四层架构`。其中最高分取 topic 内 max(session.score),session 数取 sessionIds.length。
- description 写 AI 的 reason(聚合理由 + 排序理由),后面接一句涵盖范围(日期跨度)。
- 用户从中勾选 1-3 个。

AskUserQuestion 一屏最多 4 个选项。所以一次只展示 top 4;用户都不满意,翻下一屏(5-8)。同一 topic 内的多个 sessionId 不要拆成多个选项。

### 步 4 — 你(主 Claude)自己取证

逐个处理选中的 topic。手头有 sessionIds 和元数据,用自己的工具按需收集证据。叙事对象是事件,产物比对话重要。看到能下笔了就停。

清单仅供参考,不必按顺序、不必全跑。视 topic 性质自选。

- **session 元数据**。从 `~/.ai-best-practice/data/index.jsonl` 按 sessionIds grep 出对应行,合并 tags / tools / skills / mcpServers / filesEdited;时间窗取 `[min(startedAt), max(endedAt)]`。
- **git 证据(优先级最高)**。进入 session 的 cwd,先 `git log --since=<起> --until=<止> --oneline` 扫一眼。挑跟 topic 标题或 tags 最相关的 1-3 个 commit,跑 `git show --stat <hash>` 看变更概览。stat 不足以判断意图时,才动 `git show --patch` 翻 diff 原文;且只看你怀疑的那个文件(`git show <hash> -- <file>`),整块 patch 不要。
- **artifact 原文**。filesEdited 合并完后挑 1-3 个最能说明问题的文件(.md 或关键代码),`Read` 即可,一次最多 200 行(用 offset/limit 参数,不要整文件读)。够了停。
- **对话流水**。默认跳过。只有当 git 与 artifact 都解释不了作者动机时,才回头 Read 对应 sessionId 的 jsonl 文件,头 40 行加尾 40 行(`head -n 40` + `tail -n 40`)。

判断"够了"的标准:动机—方案—得失都能讲清楚。不追求覆盖所有证据,追求够下笔。

取证过程不要复述文件原文,不要做信息搬运。脑子里有就行。起草直接用。

多个 topic 各自跑一遍步 4。

### 步 5 — 起草 + 评审(Peterson 流程 + 5 路 subagent 同行评审)

起草由主 Claude 全程负责。流程是一条线:大纲先行、段落生成、砍句、砍段、反推大纲做 sanity check、5 路 subagent 同行评审、落盘最终版本。前半段靠预设结构把事情想透,后半段靠并行 peer review 兜住主对话自查不出的低质量。

风格只剩一份**短** `STYLE_GUIDE`(3-8 行,指方向,不列规则)。5c 开始写段落之前读一次。

`scripts/lib/draft.js` 导出三样:`STYLE_GUIDE`、`titleToSlug`、`extractTitle`。

#### 5a — 采访补证据(按 topic)

步 4 收的证据已在工作记忆里。这步基于它们,直接在下一条回复里产出 fenced JSON。**不要回去 Read / Bash / 取证**。该收的已经收够。

形状:

\`\`\`json
{
  "questions": [
    {
      "question": "本次最痛的痛点是什么?",
      "header": "动机",
      "options": ["每周手动翻历史耗时", "周报内容主观难复用", "想试 Claude Code 的 hook 能力"]
    }
  ]
}
\`\`\`

约束:

- questions 控制在 **1-3 题**。明显没什么可问就 1 题或不问。题数越多,5c 起草时把每个答案塞进文章的压力越大。AskUserQuestion 硬上限是 4。
- 专问 LLM 从证据看不出来的事:动机、痛点强度、被淘汰的备选、真实 ROI、复用面、走过的弯路、当时心理。
- 每题 options 2-3 个。第一个写基于证据的最佳猜测;用户直接点 = 静默接受。
- header 自取一个 2-4 字短标签,贴题意(动机/选型/坑/复盘 等)。
- 中文要口语化,用户瞄一眼即懂。
- 不要预先写正文段落。采访是补证据,不是搭脚手架。

将 questions 一次性打包到 `AskUserQuestion`,字段对应:`question` / `header` / `options`(第一个 label 后面加 ` (推荐)`)。
answers 收上来后按 questions 原顺序对齐。用户走 Other 或跳过的,answer 置 `null`。

#### 5b — 大纲(Claude 先草一份 + 一次 AskUserQuestion 收用户输入)

证据(步 4)+ 答复(5a)凑齐,下一条回复里直接草大纲。一行一段主题句,**5-12 行**之间。案例短就 5 行,长就 12 行,不必凑数。形状(fenced 贴出来):

\`\`\`
1. 起因:hook 不可靠导致漏扫,周报素材丢
2. 决定加 pick 启动时静默兜底,而不是修 hook
3. 实现:scan.js 加 --recent 14d,mtime cache 兜底
4. 验证:本周漏扫 5 个 session 全部补回
5. 这个模式可以复用到其他"hook 不保险"的场景
\`\`\`

要求:

- 主题句直陈。不要标语化。
- 排出来的顺序就是文章段落顺序。
- 信息密度低的行直接砍。宁可少一段,不要凑。

然后一次 `AskUserQuestion`,二选一:

- "采纳 (推荐)" → 直接进 5c
- "我有想法 / 改动(在 Other 里告诉我:大纲、主张、想说的话、想保留的内容、重点是 X、删 X 段...都行)"
  → 把 Other 里的内容吃进来(扩写 / 替换 / 嵌入大纲),进 5c

强烈推荐用户走 Option 2。哪怕只是一句"重点要 X"或"删 X 那段",都比什么都不给强。Claude 不会读心术 — 从证据它能拼出"你做了什么",但不知道你想突出哪条线、想让读者带走什么。Option 2 的 Other 字段什么都收:完整大纲、几个 bullet、一句指令都行。

#### 5c — 段落起草

先把 STYLE_GUIDE 读进上下文:

\`\`\`bash
node -e 'console.log(require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft").STYLE_GUIDE)'
\`\`\`

照着大纲一行写一段。每段 **3-6 句**。宁多勿少;反正 5d 拿砍刀回来收拾。

**避免"知识的诅咒"**。后文才定义的概念、术语、缩写、内部黑话,不许在前文先出现 — 哪怕只是顺手举例。前文用到的每个名词,必须在它出现的位置(或更前面)就能站得住 — 要么是通识,要么前文已经落地过。需要某个后定义的术语,就把它的解释往前挪,或者把那段叙述往后挪。

不必预设小标题结构。短就一段段平铺过去。长就按事件分小节。看情况办。

#### 5d — 句子级砍刀

逐段重读,每句过一遍:

- 删了,段落还成立吗?成立就删。
- 有更短、更具体的说法吗?有就换。
- 跟前后句重复了吗?合并,或删一个。

#### 5e — 段落级砍刀 + 重排

每段问一遍:

- 整段删了,文章还成立吗?成立就删。
- 顺序对吗?该挪就挪。
- 跟相邻段冗余吗?合并。

#### 5f — 反推大纲 sanity check(必须通过)

从修剪后的版本反向提取每段主题句,组成"事后大纲"。跟 5b 大纲比对:

- 几乎一致 → 通过,进 5g。
- 差异大但事后大纲更连贯 → 通过。说明写的过程中真想清楚了。
- 差异大且事后大纲散 → 回 5d/5e 重新组织段落,循环到通过。

#### 5g — 5 路 subagent 同行评审(必须通过)

落盘前必须过 5 路 peer review。每路一个独立 `Agent` 调用(`subagent_type: "general-purpose"`),**5 个 Agent 必须在同一条 message 里并行发出**(一个 tool block 多个 tool_use)。每路只看你给的文章全文 + 它自己的角色 prompt,返回结构化反馈。

5 路角色分工:

| # | 角色 | 关注 |
|---|---|---|
| 1 | **AI 审查员** | 哪段读起来像 LLM 写的?AI 味整体打几分? |
| 2 | **同级同事**(同 level 工程师) | 我会读完吗?学到了什么?哪里不清楚? |
| 3 | **技术专家**(20 年资深) | 技术上有漏洞吗?缺关键 context 吗?反方案讨论过吗? |
| 4 | **公司老板**(VP / CEO 视角) | ROI 在哪?复用面有多大?业务影响讲清楚了吗? |
| 5 | **技术文档撰写专家** | 结构合理吗?扫读性 OK 吗?段落-句子层级清晰吗? |

每个 Agent 的 prompt 模板(把 `<ARTICLE>` 换成你修订后的全文):

\`\`\`
你是一位[角色],[一句话能力定位]。

我手里有一篇 OKR 周报案例,即将作为最终版本交付。落盘前要过 5 路 peer review,
你是其中一路。**严格从你的角色视角**审,不要客气。

文章如下:
===
<ARTICLE>
===

按以下结构返回(中文,< 400 字):

1. **整体判定**: 合格 / 边缘 / 不合格 + 一句话理由
2. **3 条最关键的问题**(没有就少写,严重的先写):
   - 引具体段落或句子
   - 说为什么这是问题
   - 给出改写或修复建议
3. **必改 vs 可选**: 哪些是必改(不改就不合格),哪些是可选优化

不要复述文章内容。不要展开赞美。聚焦你这个角色最该提的问题。
\`\`\`

并行 5 路发完、反馈收齐之后,主对话走以下 6 步:

1. **合并去重**。不同角色提了类似问题,合并。
2. **按严重度排序**。必改在前,可选在后。
3. **必改全部应用**。回 5c/5d/5e 重写对应段落或句子。
4. **可选挑 0-2 条最关键的应用**。
5. 改完之后再过一次 5f 反推大纲 sanity check,防止改出新的结构问题。
6. 任何一路打了"不合格" → 必改应用完之后,再发第二轮 5 路评审。一直到全员"合格 / 边缘"为止。

#### 5h — 句式打散(必须做)

**默认 5g 出来的版本不合格**,必须经过这一步重写才能进 5i。

**逐 sub-sentence 打散**。每个逗号、句号、冒号、分号之间的字符都必须换。每个分句至少动一项:起头、动词、修辞、句式、长度。具体动几项随机,改动幅度随机。

语感往**"很少写文档的人写书面语"**调 — 有点不熟练,有点直白,但确实是在写正式文字。带语气词("嘛"、"吧"、"呢"、"其实"、"反正"……该用就用)。

句和句之间用接续词串顺("所以"、"不过"、"再就是"、"另外"、"这样的话"、"那"……不要清一色"因此 / 然而"那种生硬连接)。

前提:叙述准确,读起来通顺。

打散完反向看一遍 — 如果能从你的改动里抠出一条 SOP(每个分句都做了同一项变换、语气词只用同一个、接续词只换了一种,等等),**整版推倒重做**。

完成后进 5i。

#### 5i — 落盘(最终版本)

\`\`\`bash
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<案例名 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
\`\`\`

`WEEK_PREFIX` 长得像 `2026-W20`,直接从时间范围里取。没 ISO 周时退回 `recent-3d`。然后 `Write` 落盘到 `~/.ai-best-practice/weekly/<期号>-<slug>.md`。

写出去就是最终版本。不假设用户会再 review。

#### 5j — 多 topic 情况

用户在步 3 勾了 ≥ 2 个 topic 的情况下,每个 topic 各自跑一遍 5a + 5b + 5c + 5d + 5e + 5f。所有 topic 段落修订完之后,一次性跑 5g 5 路评审 — reviewer 看完整的多 topic 文章,不要逐 topic 评。评审整改完之后再统一跑一次 5h 句式打散。最后一次 5i 写多 topic 版的 markdown:H1 是期号,每 case H2 是案例名。

单 topic 涵盖多 session 仍按单 topic 处理。这是一件事,不是多件事。聚类的意义就在这。

### 步 6 — 报告

- 输出文件路径。
- 没选上的 topic(下次还能用),每条标上涵盖几个 session。

输出落在 `~/.ai-best-practice/weekly/`。想换地方用 `AIBP_DATA_DIR` 覆盖。这个路径不在插件目录里,所以插件升级不会丢历史输出。

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

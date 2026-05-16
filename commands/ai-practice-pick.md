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

### 步 0.5 — 静默 scan 兜底(必跑)

hook 不可靠(关窗、`/exit`、强杀都会漏触发 SessionEnd),所以 pick 启动时**先静默扫一遍最近 14 天**,
让漏网的 session 自动补索引。带 mtime cache,已索引的全跳过,基本不花钱。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --recent 14d
```

让它跑完(通常 < 30 秒,新 session 多就久一点)。报错或超时不要紧 — 索引主体已经在,可以继续步 1。
**不要**跟用户解释这步,跑完直接往下走。

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

判断"够了":你能说清这件事的"动机—方案—得失",就停。不追求"覆盖所有证据",追求"足够下笔"。

收集过程你**不要**把每个文件原文复述出来,**不要**做信息搬运 — 你的工作记忆里有就行,下一步起草直接用。

多 topic 各自跑一次步 4。

### 步 5 — 起草(Peterson Essay Writing Guide 流程)

起草由你(主 Claude)亲自驱动。**废除"摸用户语气画像"和"AI_TELLS 形式自检"两套约束** —
聊天和写作是两种语域,采样聊天画出的画像本身错位;AI_TELLS 是事后形式补救,救不了
结构性的 AI 思考方式。

换上 Jordan Peterson 的写作流程:**大纲先行 → 段落生成 → 砍句 → 砍段 → 反推大纲做 sanity check**。
预设结构撬动作者把事情真想清楚,比事后形式审查有效。

唯一的风格锚是一份**短** `STYLE_GUIDE`(3-8 行,只指方向),在 5d 起草段落前读一次。

`scripts/lib/draft.js` 提供 `STYLE_GUIDE` + `titleToSlug` + `extractTitle`,其余从简。

#### 5a — 采访补证据(按 topic)

基于步 4 收集到的证据(已在你的工作记忆里),为这个 topic 在**你的下一条回复里**产出一个 fenced JSON。
**不要再 Read / Bash / 取证** — 步 4 已经够了。

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

要求:
- questions **1-3 题**。没明显问的就 1 题或不问 — 题数越多,5d 起草时把每个答案都塞进文章的压力越大。AskUserQuestion 上限是 4。
- 专问 LLM 从证据看不出的事:动机、痛点强度、被淘汰的备选、真实 ROI、复用面、走过的弯路、当时心理。
- 每题 options 2-3 个,第一个是基于证据的最佳猜测(用户直接点 = 静默接受)。
- header 2-4 字短标签,你按题意自取(动机/选型/坑/复盘 等)。
- 用户秒懂的口语化中文。
- **不要预先写正文草稿。** 采访只为补证据,不为搭脚手架。

紧接着把 questions 打包到一次 `AskUserQuestion` 调用,字段对应:`question` / `header` / `options`(第一个 label 加 ` (推荐)` 后缀)。
收集 answers,严格按 questions 原顺序。用户走 Other 或跳过的 answer 就 `null`。

#### 5b — 起草大纲

基于(步 4 证据 + 5a 答复),在下一条回复里产出大纲。**一行一段的主题句,5-12 行**(案例长度决定;
短就 5,长就 12,不必凑数)。

形状(fenced 贴出来):

\`\`\`
1. 起因:hook 不可靠导致漏扫,周报素材丢
2. 决定加 pick 启动时静默兜底,而不是修 hook
3. 实现:scan.js 加 --recent 14d,mtime cache 兜底
4. 验证:本周漏扫 5 个 session 全部补回
5. 这个模式可以复用到其他"hook 不保险"的场景
\`\`\`

要求:
- 主题句直陈,不要标语化
- 顺序就是文章段落顺序
- 信息密度低的行直接删,宁可少一段也别凑

#### 5c — 大纲确认(一次 AskUserQuestion)

一道题,三选项:

- "采纳 Claude 起草的大纲 (推荐)" → 直接进 5d
- "我重写大纲(下一条消息发给我)" → 你回 "好,把大纲发我,一行一段最好",**当前 slash command 流程结束**。
  用户下一条消息发来大纲,主对话里你看到后自然续上 5d。
- "微调某条(Other 填修改)" → Other 字段会带回用户的具体修改指令。应用修改后进 5d。

不必再请用户验证修改后的大纲 — 已经够多 round-trip 了。

#### 5d — 段落起草

**先把 STYLE_GUIDE 读进上下文**:

\`\`\`bash
node -e 'console.log(require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft").STYLE_GUIDE)'
\`\`\`

然后对大纲里**每一行**写一段。Peterson 原版建议每段 10 句,但 OKR 周报案例更紧 —
每段 **3-6 句**。宁多勿少,5e 砍刀要砍掉的就是这些。

不要预设小标题结构 — 短就一段段平铺,长就按事件分小节,看情况定。

#### 5e — 句子级砍刀(Peterson 核心)

逐段重读,对每一句问:

- 删了,段落还成立吗?成立就删。
- 能换个更短/更具体的说法吗?能就换。
- 跟前后句是否冗余?是就合并或删一个。

Peterson 原话:"试着删掉每一句,看会不会出问题;不出问题就删。"

#### 5f — 段落级砍刀 + 重排(Peterson 核心)

对每一段问:

- 删了整篇还成立吗?成立就删。
- 顺序对吗?该挪就挪。
- 跟相邻段有冗余吗?合并。

#### 5g — 反推大纲 sanity check

从修剪后的草稿反向提取每段主题句,组成"事后大纲"。跟 5b 原大纲(或用户改后的版本)对比:

- 几乎一致 → 直接落盘。
- 差异大但事后大纲更连贯 → 默认事后大纲为对,落盘。
- 差异大且事后大纲松散 → 在 5i 报告里标注"写的时候跑题了,事后大纲跟原大纲分歧",
  但**不再循环重写**(缩水版决策,缩短反复)。

#### 5h — 落盘

\`\`\`bash
node -e '
const path = require("path");
const { titleToSlug } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/draft");
const { WEEKLY_DIR } = require(process.env.CLAUDE_PLUGIN_ROOT + "/scripts/lib/paths");
console.log(path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + titleToSlug(process.env.TITLE) + ".md"));
' # TITLE=<案例名 或 期号> WEEK_PREFIX=<2026-W20 或 recent-3d>
\`\`\`

`WEEK_PREFIX` 形如 `2026-W20`(直接取自时间范围,没 ISO 周时用 `recent-3d`)。
用 `Write` 落盘到 `~/.ai-best-practice/weekly/<期号>-<slug>.md`。

#### 5i — 多 topic 情况

如果用户在步 3 勾了 ≥ 2 个 topic:对每个 topic 各跑 5a + 5b + 5c + 5d + 5e + 5f + 5g。
所有 topic 修订完之后,**一次** 5h 写一份多 topic 版的 markdown:H1 是期号,
每 case H2 是案例名。

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

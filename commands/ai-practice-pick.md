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

### 步 5 — 起草:两阶段 + 一轮采访

起草流程不再是一次 LLM 大调用。换成:LLM 先给 STAR 初稿 + 采访问题,你(Claude)在主对话里
逐题问用户,用户答完再二次定稿。整套服务一个假想敌:公司内部的"AI 最佳实践审计 AI"
(它的 7 条探针已写进 `lib/draft.js::AUDITOR_LENS`)。

#### 5a — 出初稿和问题

对**每个**选中的 sessionId,单独调一次:

```bash
node -e '
const fs = require("fs");
const { proposeAndProbe } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/draft");
const evidencePack = JSON.parse(fs.readFileSync(0, "utf8"));
proposeAndProbe({rangeLabel: process.env.RANGE_LABEL, evidencePack}).then(r => {
  console.log(JSON.stringify(r));
});' <<< "$EVIDENCE_JSON"
```

返回结构(参考 `PROBE_SCHEMA`):
```json
{
  "proposedTitle": "会话评分流水线工程化",
  "draftSTAR": { "situation": "...", "task": "...", "action": "...", "result": "..." },
  "questions": [
    { "module": "S", "prompt": "本次最痛的痛点是什么?",
      "options": ["每周手动翻历史耗时", "周报内容主观难复用", "想试 Claude Code 的 hook 能力"] },
    ...
  ]
}
```

#### 5b — 采访用户(每题一个 AskUserQuestion)

对每个 question 调一次 **AskUserQuestion**:
- `question` = `question.prompt`
- `header` = 按 module 翻译:`S` → `背景`、`T` → `目标`、`A` → `做法`、`R` → `结果`
- `options[0].label` = `question.options[0]`(LLM 最佳猜测,加 `(推荐)` 后缀)
- 其余 options 平铺
- 不要 `multiSelect`,单选即可,用户也可走 Other 自由填

收集 answers 数组:`[{module, prompt, answer}]`。用户没作答(取消/空)的就 `answer: null`。

#### 5c — 最终定稿

```bash
node -e '
const fs = require("fs");
const path = require("path");
const { finalize, titleToSlug } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/draft");
const { WEEKLY_DIR } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/paths");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
finalize(payload).then(r => {
  fs.mkdirSync(WEEKLY_DIR, { recursive: true });
  const slug = titleToSlug(r.title);
  const outPath = path.join(WEEKLY_DIR, process.env.WEEK_PREFIX + "-" + slug + ".md");
  fs.writeFileSync(outPath, r.markdown);
  console.log(JSON.stringify({path: outPath, cost: r.cost, retried: r.retried}));
});' <<< "$FINAL_INPUT_JSON"
```

`FINAL_INPUT_JSON` 是 `{rangeLabel, evidencePack, drafts: draftSTAR, answers, hasMultipleCases}`。
`WEEK_PREFIX` 形如 `2026-W20`(直接取自时间范围,没 ISO 周时用 `recent-3d` 这种)。

#### 5d — 多案例情况

如果用户在步 3 勾了 ≥ 2 条 session,先对每个 session 走完 5a-5b(每案各采访一组问题),
然后**一次** 5c 调用,传 `hasMultipleCases: true`,`evidencePack` 是数组,`drafts` 也是数组。
finalize 会输出 H1=期号、每案 H2=case 名的多案例版式。

单案例(勾了 1 条)→ `hasMultipleCases: false`,H1 直接是案例名,无 H2。

### 步 6 — 报告

- 输出文件路径
- 起草成本(初稿 + 终稿,若触发禁用词重写就加重写成本)
- 是否触发了禁用短语重写(`retried: true` 提一下)
- 未选中的候选(下次可用)
- 提示用户:**这是初稿,审计 AI 探针只是设计假想敌,真审稿要靠人**。检阅后再提交。

周报落在 `~/.ai-best-practice/weekly/`(可用 `AIBP_DATA_DIR` 覆盖),
不在插件目录里,插件升级不会丢历史草稿。

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

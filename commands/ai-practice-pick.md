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

### 步 4 — 抽细节

对勾选的每个 sessionId,从 `index.jsonl` 取 `jsonlPath`,**Read 原始 jsonl 头尾各 ~50 行**
(整文件不要塞进主对话),组装详细 case JSON。

### 步 5 — 起草

把 cases pipe 给 `lib/draft.js`(内部走 `claude -p --model sonnet-4-6`):

```bash
RANGE_LABEL="<根据用户参数生成,如 2026-W20 / 最近 3 天 / 全周期>" \
OUT_NAME="<安全文件名(不含扩展名),如 2026-W20 / recent-3d>" \
node -e '
const path = require("path");
const fs = require("fs");
const cases = JSON.parse(fs.readFileSync(0,"utf8"));
const { draft } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/draft");
const { WEEKLY_DIR } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/paths");
fs.mkdirSync(WEEKLY_DIR, { recursive: true });
const outPath = path.join(WEEKLY_DIR, process.env.OUT_NAME + ".md");
draft({rangeLabel: process.env.RANGE_LABEL, cases}).then(r=>{
  fs.writeFileSync(outPath, r.markdown);
  console.log(JSON.stringify({path: outPath, cost: r.cost}));
});' <<< "$CASES_JSON"
```

周报落在 `~/.claude/ai-best-practice/weekly/`(可用 `AIBP_DATA_DIR` 覆盖),
不在插件目录里,所以插件升级不会丢历史草稿。

### 步 6 — 报告

- 输出文件路径
- 起草成本
- 未选中的候选(下次可用)
- 提示用户人工检阅后再提交

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

---
description: "从已索引的 AI 会话里挑案例并生成中文小作文初稿。默认全周期,可加 --week/--month/--since/--tag 过滤。"
argument-hint: "[--week YYYY-Www] [--month YYYY-MM] [--since YYYY-MM-DD] [--tag X] [--top N]"
allowed-tools: [Bash, Read, Write, AskUserQuestion]
---

# ai-practice-pick

把"找素材 + 写作文"的全流程串起来。**默认全周期**;过滤维度通过参数显式给出。

## 工作流(严格按顺序执行)

### 1. 拉候选粗排

把用户的 `$ARGUMENTS` 原样转给 list.js:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/list.js $ARGUMENTS
```

输出是 JSON 数组(按 score 降序的前 N 条,默认 30)。

如果数组为空:告诉用户"当前过滤条件下无候选,请先 `/ai-practice-scan` 或调整过滤"。

### 2. AI 二次排序(走 claude -p,不在主对话里思考)

把候选列表的精简信息(date / score / summary / highlights / tags)送给 Haiku
做"作为本期 OKR 案例的合适度"重排,理由考虑:
- 时效性:近期优先
- 多样性:tags 错开,避免同主题扎堆
- 故事完整度:highlights 数量与 summary 信息密度

执行方式:用 Bash 调:

```bash
node -e '
const cases = JSON.parse(require("fs").readFileSync(0,"utf8"));
const slim = cases.map(c=>({sessionId:c.sessionId,date:c.date,score:c.score,summary:c.summary,tags:c.tags}));
const prompt = `下面是若干候选 Claude Code 会话(JSON)。请按"作为 OKR 周报案例的合适度"重排,
考虑时效、多样性、故事完整度。只输出 JSON 数组 [{"sessionId":"...","rank":1,"reason":"一句中文"}]。

${JSON.stringify(slim,null,2)}`;
process.stdout.write(prompt);
' <<< "$LIST_JSON" | claude -p --bare --no-session-persistence \
  --permission-mode bypassPermissions --model claude-haiku-4-5 --output-format json \
  --json-schema '{"type":"array","items":{"type":"object","required":["sessionId","rank","reason"],"properties":{"sessionId":{"type":"string"},"rank":{"type":"integer"},"reason":{"type":"string"}}}}'
```

把 `structured_output` 取出,作为新顺序;若失败,降级用 score 顺序,并提示用户。

只保留 top 10 进入下一步。

### 3. 给用户挑选

用 **AskUserQuestion** (`multiSelect: true`) 把 10 条呈现:
- header: "案例"
- label 形如:`[88] 2026-05-10 用 hook 索引 AI 会话(automation, meta)`
- description: 完整 summary
- 用户勾选 1-3 条作为本期素材

### 4. 抽取细节

对勾选的 sessionId,从 index.jsonl 取 `jsonlPath`,Read 原始 jsonl 头尾各 ~50 行,
人工抽出可贴的命令、文件、产物路径,组装成详细 case JSON:

```json
[
  {
    "sessionId": "...",
    "title": "<根据 summary 总结的简短标题>",
    "summary": "...",
    "highlights": [...],
    "tags": [...],
    "endedAt": "...",
    "filesEditedSample": [...],
    "concreteEvidence": "<从 jsonl 抽出的具体命令/文件路径/PR 等>"
  }
]
```

### 5. 走 claude -p 起草

```bash
node -e '
const cases = JSON.parse(require("fs").readFileSync(0,"utf8"));
const { draft } = require("'${CLAUDE_PLUGIN_ROOT}'/scripts/lib/draft");
draft({rangeLabel: process.env.RANGE_LABEL, cases}).then(r=>{
  require("fs").writeFileSync(process.env.OUT_PATH, r.markdown);
  console.log(JSON.stringify({path: process.env.OUT_PATH, cost: r.cost}));
}).catch(e=>{console.error(e); process.exit(1)});
' <<< "$CASES_JSON"
```

`RANGE_LABEL`:根据用户参数生成,如 `2026-W19`、`2026-05`、`since 2026-05-01`、`全周期`。
`OUT_PATH`:`${CLAUDE_PLUGIN_ROOT}/weekly/<RANGE_LABEL>.md`(无效字符替换为 `-`)。

### 6. 报告产出

- 输出文件路径
- 草稿成本
- 候选池里**未选中**的剩余条目(供用户下次提交参考)
- 提示:人工检阅后再提交

## 注意

- 全程不要把整个 jsonl 往主对话里读,只读头尾必要片段
- AskUserQuestion 限制最多 4 个选项时,改为分页或要求用户收窄过滤条件
- 起草模型默认 Sonnet 4.6,可 `AIBP_DRAFT_MODEL` 覆盖

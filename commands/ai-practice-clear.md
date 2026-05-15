---
description: "清空 Haiku 打分缓存(index.jsonl)。下次扫描会重新评分所有会话。"
allowed-tools: [Bash, AskUserQuestion]
---

# ai-practice-clear

清空打分缓存 = 删除 `~/.ai-best-practice/data/index.jsonl`(可用 `AIBP_DATA_DIR` 覆盖根目录)。

下次跑 `/ai-practice-scan` 会**重新评分所有会话**(每条 ~$0.054,作者本机 346 条 ≈ $19),所以这是个破坏性操作 — 必须先确认。

`weekly/` 下的周报草稿和 `logs/` **不会**被动。

## 工作流(严格按顺序)

### 步 1 — 预览将要删什么

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/clear-cache.js --info
```

输出一行 JSON,字段:
- `exists`:缓存文件是否存在
- `rows`:缓存里有几条评分记录
- `sizeBytes`:文件大小
- `path`:实际路径(便于排错)

如果 `exists: false`,直接回一句"当前没有缓存可清(`{path}` 不存在)",**不要进入步 2**。

### 步 2 — 用 AskUserQuestion 确认

按 `rows × $0.054` 粗估下次重评的成本(单条均值来自前次标定批)。

`question`:`即将删除 N 条评分记录(X KB)。下次 /ai-practice-scan 会重新评所有会话,粗估约 $Y。继续?`

- Option 1:`确认清空`
- Option 2(默认):`取消`

用户选取消就直接结束,不要跑步 3。

### 步 3 — 真删

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/clear-cache.js --clear
```

输出 JSON:`{deleted, exists, rows, sizeBytes, path}`(`exists`/`rows`/`sizeBytes` 是删之前的值)。

回一句简短确认,例如:
`已清空缓存(删除了 N 条记录)。下次 /ai-practice-scan 会重评所有会话。`

## 注意

- 只清打分缓存。如果用户其实想删的是周报草稿或日志,提醒他们手动 `rm ~/.ai-best-practice/weekly/*.md` / `rm ~/.ai-best-practice/logs/ai-best-practice.log`,不要替他们做。
- 删除后无法恢复,所以步 2 的确认不可省略。

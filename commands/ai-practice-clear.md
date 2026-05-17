---
description: "清空 Haiku 打分缓存(index.jsonl)。下次扫描会重新评分所有会话。"
allowed-tools: [Bash, AskUserQuestion]
---

# ai-practice-clear

删除 `~/.ai-best-practice/data/index.jsonl`(可用 `AIBP_DATA_DIR` 覆盖根目录)。下次 `/ai-practice-scan` 会重评所有会话。`weekly/` 和 `logs/` 不动。

## 步 1 — 预览

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/clear-cache.js --info
```

返回 `{exists, rows, sizeBytes, path}`。

`exists: false` → 回一句"当前没有缓存可清(`{path}` 不存在)",结束。

## 步 2 — AskUserQuestion 确认

`question`:`即将删除 N 条评分记录(X KB)。下次 /ai-practice-scan 会重新评所有会话。继续?`

- Option 1:`确认清空`
- Option 2(默认):`取消`

取消 → 结束。

## 步 3 — 真删

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/clear-cache.js --clear
```

回一句:`已清空缓存(删除了 N 条记录)。下次 /ai-practice-scan 会重评所有会话。`

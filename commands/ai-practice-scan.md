---
description: "扫描 Claude Code 历史会话,调 Haiku 评分入库 data/index.jsonl。增量为默认。"
argument-hint: "[--full] [--limit N] [--since YYYY-MM-DD]"
allowed-tools: [Bash]
---

# ai-practice-scan

扫描 `~/.claude/projects/` 下符合范围(cwd 命中 `/Users/lqy/tyc` 或 `/Users/lqy/.claude`)
的会话 jsonl,经过 `parse-jsonl → score(Haiku 4.5)` 落入 `data/index.jsonl`。

## 你的任务

1. 解析用户传入的参数 `$ARGUMENTS`,原样转发给 scan.js。
2. 用 Bash 跑:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js $ARGUMENTS
   ```
3. 命令会实时打印进度。结束后向用户报告:
   - 扫描总数 / 新增 / 缓存命中 / 跳过 / 错误
   - 累计成本(USD)
   - `data/index.jsonl` 当前总条数(`wc -l`)
4. 如果发现 `--full` 全量扫描首次跑、且候选数 > 50,**先提醒用户预估成本**
   (经验值:每条约 $0.005–$0.05,大会话更贵),让用户确认后再执行。

## 注意

- scan.js 自带 jsonlMtime 缓存,重复跑只会处理增量
- 评分模型可用环境变量 `AIBP_SCORE_MODEL` 覆盖(默认 `claude-haiku-4-5`)
- 失败的会话写入 `~/.claude/logs/ai-best-practice.log`,人工查看

---
description: "扫描 Claude Code 历史会话,调 Haiku 评分入库。默认全量带缓存,接受自然语言参数。"
argument-hint: "可选自然语言,如:本周 / 最近 7 天 / 重新评分 / 不限"
allowed-tools: [Bash]
---

# ai-practice-scan

把 `~/.claude/projects/` 下的会话评分入库到 `~/.claude/ai-best-practice/data/index.jsonl`
(数据放在插件目录外,插件升级不会丢;可用 `AIBP_DATA_DIR` 覆盖)。

**默认行为(无参数 = 全量 + 带缓存)**:遍历所有 jsonl,首次跑会评所有 session;
之后再跑只评新增/变更(`jsonlMtime` 未变就跳过,不花钱)。

## 你(Claude)收到的参数

`$ARGUMENTS` 是用户输入的**自然语言**,例如:
- "本周" / "这周" / "最近一周" / "近 7 天"
- "最近三天" / "近 3 天" / "过去 72 小时"
- "上个月" / "5 月份" / "2026-05"
- "重新评分" / "强制重评" / "ignore cache" / "rescore"
- "" 或 "全部" 或 "默认" — 全量带缓存

## 你要做的事

1. **解析参数**(无需调 LLM,你自己用上下文 + 当前日期想清楚就行):
   - 时间范围词 → 转成具体的 `--recent <Nd>` 或 `--since YYYY-MM-DD`
   - "重新评分" 类 → 加 `--rescore`
   - 没有明确范围 → 不加时间参数(意味着扫所有)
   - 多个意图叠加(如"重新评分最近 7 天")→ 同时加 `--rescore --recent 7d`

2. **跑脚本**:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js <你解析出的参数>
   ```

3. **报告**:扫描总数 / 新增 / 缓存命中 / 跳过 / 错误 / 累计 cost,以及 `index.jsonl` 现在多少条。

## 内部脚本支持的 flag(供你拼接,不要直接暴露给用户)

| flag | 含义 |
|---|---|
| 无参数 | 全部 jsonl,带缓存(推荐日常) |
| `--rescore` | 忽略缓存,所有 session 重评 |
| `--recent 7d` | 最近 N 天(`d`/`w`/`m`,如 `3d`、`2w`、`1m`) |
| `--since 2026-05-01` | 起始日期 |
| `--limit 10` | 仅前 N 条(主要给调试用) |

## 注意

- 首次全量约 ~340 会话、$5–$15、40–60 分钟(4 并发)。如果用户没明确"全量",且 `index.jsonl` 是空的,**先提醒一下成本和时长**,让用户确认。
- 评分模型默认 Haiku 4.5,失败日志在 `~/.claude/logs/ai-best-practice.log`。

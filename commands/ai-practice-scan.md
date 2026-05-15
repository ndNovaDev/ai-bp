---
description: "扫描 Claude Code 历史会话,调 Haiku 评分入库。默认全量带缓存,接受自然语言参数。"
argument-hint: "可选自然语言,如:本周 / 最近 7 天 / 重新评分 / 不限"
allowed-tools: [Bash, AskUserQuestion, TaskOutput]
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

## 工作流(严格按顺序执行)

### 步 0 — 解析参数

无需调 LLM,你自己用上下文 + 当前日期想清楚就行:
- 时间范围词 → 转成 `--recent <Nd>` 或 `--since YYYY-MM-DD`
- "重新评分" 类 → 加 `--rescore`
- 没有明确范围 → 不加时间参数(扫所有)
- 多个意图叠加(如"重新评分最近 7 天")→ 同时加 `--rescore --recent 7d`

下面用 `$FLAGS` 代指你拼出来的参数串。

### 步 1 — Preflight 计数

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --count-only $FLAGS
```

输出一行 JSON,例如:
```json
{"candidates":346,"alreadyScored":148,"newToScore":198,"concurrency":8,"indexSize":150}
```

字段:
- `candidates`:满足过滤条件的 jsonl 总数
- `alreadyScored`:已在 index 里且 mtime 未变(会命中缓存,不花钱)
- `newToScore`:真正会调 Haiku 评分的条数 ← **成本主要看它**
- `concurrency`:并发数(可通过 `AIBP_CONCURRENCY` 覆盖)

### 步 2 — 粗估 + 决定是否需要标定

判断:
- `newToScore == 0` → 全是缓存,**直接跳到步 4**(只为更新可能的新会话)
- `newToScore < 10` → 量太少,标定意义不大,**直接跳到步 4** 但报告一下粗估
- `newToScore >= 10` → 走步 3 标定

粗估公式(经验值,基于 Haiku 4.5):
- 单条成本 $0.005–0.02(取决于会话长度)
- 单条墙钟 ≈ `(card 体积 / 网络 + Haiku 处理) / concurrency`,典型 1–4 秒/条(8 并发下)
- 报给用户:`本机有 N 条需要评分,粗估 $A–$B、约 M 分钟,先标定 10 条拿真实数字`

### 步 3 — 标定批

跑 10 条:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js --limit 10 $FLAGS
```

抓最后一行 `[scan] done ...` 里的字段:
- `cost=$X.XX`:这 10 条总花费
- `elapsed_sec=Y.Y`:这 10 条墙钟秒
- `avg_cost=$Z.ZZZZ`、`avg_sec=W.WW`:已经算好的单条均值

外推剩余 `(newToScore - 10)` 条:
- 预估总花费 `≈ avg_cost × (newToScore - 10) + 这次的 cost`
- 预估墙钟分钟数 `≈ avg_sec × (newToScore - 10) / concurrency / 60 + 已用的`

把这两个数字、以及标定批本身的实测,汇总成一段简短报告给用户。

### 步 4 — 用 AskUserQuestion 让用户拍板

`question`:`已标定 10 条,实测 $X、Y 秒。剩余 N 条预计 $A–B、Z 分钟,继续吗?`
- Option 1(推荐):`继续跑完`
- Option 2:`先停,只要这 10 条就够` — 直接结束,不跑步 5
- Option 3:`降并发到 2 再跑` — 告诉用户重新跑命令 `AIBP_CONCURRENCY=2 /ai-practice-scan ...`(本次会话不能动环境变量)

若步 2 跳过了标定(`newToScore < 10`),直接 AskUserQuestion 用粗估的数字问就行。

### 步 5 — 全量跑(后台 + 轮询,**关键**)

普通 Bash 调用是阻塞的:你跑 scan.js 期间用户什么也看不到,要等到几十分钟后整个命令
返回才知道发生了什么。所以**必须**用后台跑 + 轮询:

1. **后台启动**:`Bash(command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/scan.js $FLAGS", run_in_background: true)`
   立刻拿到 `task_id` 返回,不会卡死。

2. **轮询循环**(直到任务结束):
   - 调 `TaskOutput(task_id, block: true, timeout: 30000)`,最多等 30 秒
     (block 模式下,有新输出或任务完成就提前返回;脚本每 10s 会打一行 heartbeat)
   - 从返回里抓**最新的** `[scan] heartbeat ...` 行(可能也有 `[scan] done` 表示结束)
   - 翻成一行简短的中文进度发给用户,例如:
     `进度 25/198(ok 24 / cached 0 / error 1 / 重试 1)| 已花 $0.42 | 剩余约 4.2m`
   - 若返回里出现 `[scan] done ...`,跳出循环
   - 否则继续下一轮

3. **不要轮询太快**也**不要把 stdout 全文回显给用户**。每轮就发一行总结。

步 3 已经入库的 10 条会命中 mtime 缓存自动跳过,不会重花钱。

### 步 6 — 终态报告

`[scan] done` 行包含所有最终字段。汇总给用户:
- 扫描总数 / ok / cached / skipped / error / 重试次数(若有)
- 累计 cost、墙钟时间
- `index.jsonl` 当前条数(可以用 `wc -l` 查一下)
- 失败日志:`~/.claude/logs/ai-best-practice.log`(若有 error,提醒用户去看)

## 内部脚本支持的 flag(供你拼接,不要直接暴露给用户)

| flag | 含义 |
|---|---|
| 无参数 | 全部 jsonl,带缓存(推荐日常) |
| `--count-only` | 干跑,只输出 JSON 计数,不打分 |
| `--rescore` | 忽略缓存,所有 session 重评 |
| `--recent 7d` | 最近 N 天(`d`/`w`/`m`,如 `3d`、`2w`、`1m`) |
| `--since 2026-05-01` | 起始日期 |
| `--limit 10` | 仅前 N 条 |

## 注意

- 评分模型默认 Haiku 4.5,通过 `AIBP_SCORE_MODEL` 覆盖
- 并发默认 8,通过 `AIBP_CONCURRENCY` 覆盖
- "标定 + 确认" 流程只在 `newToScore >= 10` 时触发;小批量直接跑

# ai-best-practice

把 Claude Code 历史会话沉淀为可检索、可量化、可周报化的"AI 最佳实践案例库"。
为公司 OKR("每周写一篇 AI 最佳实践小作文,Claude 打分")设计。

## 它做什么

1. 扫 `~/.claude/projects/` 里**所有**会话(不做项目级过滤,值不值由 AI 评)
2. 用 **Haiku 4.5** 给每段会话打分(0–100)+ 中文摘要 + 亮点 + 标签
3. 每次会话结束后自动增量入库(`Stop` hook)
4. 周末用 `/ai-practice-pick` 交互式挑案例 → 自动起草中文 markdown 草稿

## 目录结构

```
ai-best-practice/
├── .claude-plugin/plugin.json     # plugin 清单
├── commands/                      # /ai-practice-{scan,pick}
├── hooks/{hooks.json, on-stop.sh} # Stop hook
├── scripts/                       # 内部脚本(commands + hook 都复用)
│   ├── scan.js                    # 全量/增量扫描入口
│   ├── scan-session.js            # 单 session(给 hook 用)
│   ├── list.js                    # 候选过滤排序
│   └── lib/{parse-jsonl,score,draft}.js
├── data/index.jsonl               # 评分索引(append/覆盖,以 sessionId 为主键)
├── weekly/                        # /ai-practice-pick 产出
└── README.md
```

## 安装(本机)

放到任意目录,然后:

```bash
claude --plugin-dir /Users/lqy/tyc/ai-best-practice
```

启动一次后,plugin 会被识别,`/ai-practice-scan` 和 `/ai-practice-pick` 在 `/help` 里出现,
`Stop` hook 自动生效。

也可以把整个目录打成 zip 分发给同事,他们用 `--plugin-dir x.zip` 装。

## 使用

### 首次全量扫描

```
/ai-practice-scan --full
```

会先打印候选数。**首次预计 10–30 分钟、$5–$15 成本**(当前约 340 个有效会话,
4 并发约 1–1.5 小时,后台跑不阻塞)。后续都走 mtime 缓存,只评新增/变更。

### 日常无感:hook 自动入库

什么都不用做。每次正常退出 Claude Code 会话,后台异步打分并写入 `data/index.jsonl`。
日志在 `~/.claude/logs/ai-best-practice.log`。

### 写本周作文

```
/ai-practice-pick --week 2026-W19
```

或:

```
/ai-practice-pick                      # 全周期高分
/ai-practice-pick --month 2026-05
/ai-practice-pick --since 2026-05-10
/ai-practice-pick --tag automation
```

流程:列出候选 → AI 二次排序(时效/多样/完整度) → AskUserQuestion 给你勾 1-3 条 →
读原始 jsonl 抽细节 → 调 Sonnet 起草 → 写入 `weekly/<range>.md`。

人工检阅后提交。

## 隐私 / 体积

- `data/index.jsonl` 只存**元数据 + AI 生成的摘要**,**不复制原始对话内容**
- 单条 ~1 KB,千条会话约 1 MB
- 原文在 `~/.claude/projects/`,通过 sessionId 回查

`data/`、`weekly/`、`hooks/on-stop.sh` 产生的日志可能含工作内容摘要。
若放到 git,建议在仓库根加 `.gitignore`:

```
data/
weekly/
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AIBP_SCORE_MODEL` | `claude-haiku-4-5` | 评分模型 |
| `AIBP_DRAFT_MODEL` | `claude-sonnet-4-6` | 起草模型 |
| `AIBP_CONCURRENCY` | `4` | scan 并发数 |
| `AIBP_SCORE_TIMEOUT_MS` | `180000` | 单条评分超时 |
| `AIBP_DRAFT_TIMEOUT_MS` | `240000` | 起草超时 |

## 关键设计

- **评分流程统一**:hook、scan、pick 二次排序都走 `lib/score.js` / `claude -p`,一处迭代,处处生效
- **LLM 走 claude cli**:不直接调 Anthropic API,鉴权完全复用 Claude Code,无 key 管理
- **mtime 缓存**:重复 scan 跳过未变更的 jsonl
- **`--bare --no-session-persistence`**:防止 scorer 自己的会话被 hook 递归索引

## 故障排除

- hook 没触发:检查 `claude` 启动时是否带 `--plugin-dir`,或把 plugin 加进 marketplace
- 评分超时:大会话(jsonl > 500KB)可能需要把 `AIBP_SCORE_TIMEOUT_MS` 调到 300000
- `claude -p` 返回 is_error:看 `~/.claude/logs/ai-best-practice.log` 末尾 stderr
- 索引太少:确认 `cwd` 实际命中过滤前缀(在 jsonl 第一行 `cwd` 字段查看)

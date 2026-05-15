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

## 安装

仓库本身就是一个 marketplace,直接在 Claude Code 里两步装好:

```text
/plugin marketplace add ndNovaDev/ai-bp
/plugin install ai-best-practice@ai-bp
```

第一条把本仓库注册为 marketplace(键名 `ai-bp`),第二条安装其中的 `ai-best-practice` 插件。
安装后:

- `/ai-practice-scan` 和 `/ai-practice-pick` 自动出现在 `/help` 里
- `Stop` hook 自动生效,会话结束后台异步评分入库

升级到最新版:

```text
/plugin marketplace update ai-bp
/plugin update ai-best-practice@ai-bp
```

### 本地开发模式

如果你 clone 了本仓库并要直接调试代码改动:

```bash
claude --plugin-dir /path/to/ai-bp
```

或者用 `/plugin install ai-best-practice@local --source-path /path/to/ai-bp`。

## 使用

两条 slash command 都接受**中文自然语言**。Claude 在主对话里把你的意图翻译成具体过滤条件,
你不用记 flag 长什么样。

### 首次扫描

```text
/ai-practice-scan
```

无参数 = 全量带缓存(扫所有 jsonl,首次会评所有,以后只评新增/变更)。
**首次预计 ~340 个会话、$5–$15、40–60 分钟**(后台跑,不阻塞主对话)。

也可以加范围,例如:

```text
/ai-practice-scan 最近 7 天
/ai-practice-scan 重新评分              # 忽略缓存,所有 session 重打分
/ai-practice-scan 重新评分最近 3 天
```

### 日常无感:hook 自动入库

什么都不用做。每次正常退出 Claude Code 会话,Stop hook 后台异步打分并写入 `data/index.jsonl`。
日志在 `~/.claude/logs/ai-best-practice.log`。

### 写本周作文

```text
/ai-practice-pick                      # 全周期高分前 30 → 你勾选
/ai-practice-pick 本周                  # 或 这周 / 最近一周
/ai-practice-pick 最近三天
/ai-practice-pick 上个月关于自动化的
/ai-practice-pick 最近一周高分前 5 条
```

流程:列出候选 → AI 二次排序(时效/多样/完整度) → `AskUserQuestion` 给你勾 1–3 条 →
读原始 jsonl 抽细节 → 调 Sonnet 起草 → 写入 `weekly/<range>.md`。

人工检阅后提交。

## 隐私 / 体积

- `data/index.jsonl` 只存**元数据 + AI 生成的摘要**,**不复制原始对话内容**
- 单条 ~1 KB,千条会话约 1 MB
- 原文在 `~/.claude/projects/`,通过 sessionId 回查
- `data/` 和 `weekly/` 含工作内容摘要,**仓库已在 `.gitignore` 排除**。每个用户独立生成,
  不进版本库。

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

- hook 没触发:确认 plugin 已安装(`/plugin list` 能看到 `ai-best-practice@ai-bp`),或本地开发时启动带 `--plugin-dir`
- 评分超时:大会话(jsonl > 500KB)可能需要把 `AIBP_SCORE_TIMEOUT_MS` 调到 300000
- `claude -p` 返回 is_error:看 `~/.claude/logs/ai-best-practice.log` 末尾 stderr
- 索引为空:跑一次 `/ai-practice-scan`(空 index 等 hook 慢慢攒会很久)
- 想排除某些目录:编辑 `scripts/scan.js` 顶部的 `EXCLUDE_PREFIXES` 数组

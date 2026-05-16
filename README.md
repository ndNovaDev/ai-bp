# ai-best-practice

把 Claude Code 历史会话沉淀为可检索、可量化、可周报化的"AI 最佳实践案例库"。
为公司 OKR("每周写一篇 AI 最佳实践小作文,Claude 打分")设计。

## 它做什么

1. 扫 `~/.claude/projects/` 里**所有**会话(不做项目级过滤,值不值由 AI 评)
2. 用 **Haiku 4.5** 给每段会话打分(0–100)+ 中文摘要 + 亮点 + 标签
3. 每次会话结束后自动增量入库(`Stop` hook)
4. 周末用 `/ai-practice-pick` 交互式挑案例 → 一次性写出最终版本的中文 markdown

## 目录结构

```
ai-best-practice/
├── .claude-plugin/plugin.json     # plugin 清单
├── commands/                      # /ai-practice-{scan,pick}
├── hooks/{hooks.json, on-stop.sh} # SessionEnd hook
├── scripts/                       # 内部脚本(commands + hook 都复用)
│   ├── scan.js                    # 全量/增量扫描入口
│   ├── scan-session.js            # 单 session(给 hook 用)
│   ├── list.js                    # 候选过滤排序
│   └── lib/{parse-jsonl,score,draft,paths}.js
└── README.md
```

数据不放在仓库目录里,默认落在用户 home 下,避免插件升级时丢历史:

```
~/.ai-best-practice/
├── data/index.jsonl               # 评分索引(append/覆盖,以 sessionId 为主键)
└── weekly/                        # /ai-practice-pick 产出
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

**首次跑前会自动 preflight**:先 `--count-only` 数你本机有多少候选会话,再标定 10 条
拿实测的 `$/条` 和 `秒/条`,最后用 `AskUserQuestion` 把预估的总花费 / 墙钟时间报给你,
你拍板再跑剩余。粗估经验值是单条 $0.005–0.02 / 1–4 秒(8 并发),但实际会议长会话偏贵、
短会话偏便宜,以标定批为准。

也可以加范围,例如:

```text
/ai-practice-scan 最近 7 天
/ai-practice-scan 重新评分              # 忽略缓存,所有 session 重打分
/ai-practice-scan 重新评分最近 3 天
```

### 日常无感:hook 自动入库

什么都不用做。每次正常退出 Claude Code 会话(Ctrl+D / `/clear` / `/logout`),
SessionEnd hook 后台异步打分并写入 `~/.ai-best-practice/data/index.jsonl`。
日志在 `~/.ai-best-practice/logs/ai-best-practice.log`。

⚠️ hook 不可靠:`/exit` 斜杠退出([Claude Code issue #35892](https://github.com/anthropics/claude-code/issues/35892))、
点 X 关窗、Cmd+Q、强杀进程都会漏触发 SessionEnd。**但你不用管** — `/ai-practice-pick`
启动时会自动 scan 最近 14 天兜底,漏网会自动捡回来(mtime cache 命中已索引的全跳过,基本不花钱)。
想强制全量重扫超过 14 天的旧 session,手动跑 `/ai-practice-scan`。

### 写本周作文

```text
/ai-practice-pick                      # 全周期高分前 30 → 你勾选
/ai-practice-pick 本周                  # 或 这周 / 最近一周
/ai-practice-pick 最近三天
/ai-practice-pick 上个月关于自动化的
/ai-practice-pick 最近一周高分前 5 条
```

流程:列出候选 → AI 二次排序(时效/多样/完整度) → `AskUserQuestion` 给你勾 1–3 条 →
**主对话的 Claude**(就是你正在用的那个会话)按需收集证据(jsonl 元数据 / git log / 关键文件)
→ 出 1–3 道采访题(补 LLM 看不出的动机 / 真实 ROI / 杠杆) → 一次 `AskUserQuestion` 一屏问完 →
**问你大纲来源(强烈推荐你自己给)** → 按 Peterson 流程(段落生成 → 砍句 → 砍段 → 反推大纲)
→ `Write` 到 `~/.ai-best-practice/weekly/<期号>-<案例名 slug>.md`。

**起草不再 spawn `claude -p`**:终稿就在你当前这个 Claude Code 会话里写,复用你的模型(通常已是 1M 上下文),
共享鉴权,token 走 `/cost`。

起草走 **Jordan Peterson Essay Writing Guide 流程**:大纲 → 段落生成 → 砍句 → 砍段 → 反推大纲做
sanity check。预设结构撬动作者把事情真想清楚,比事后形式审查有效。**落盘的是最终版本,不是草稿**
—— 不要假设你回头会 review。

**强烈推荐你自己提供大纲或主张** —— 哪怕是 3-5 条 bullet 也行。Claude 不会读心术,它能从证据拼出
"你做了什么",但**不知道**你想突出哪条线、想给读者什么 take-away。自动起草的大纲多半不会是你
心里那张图。给自己 30 秒写主张比 Claude 猜半天值。

唯一的风格锚是一份**短** `STYLE_GUIDE`(3-8 行,只指方向:"按优秀技术文档/指南的标准写")。
刻意不列具体 do/don't —— 一列就退化成均值化锚点。

老版本带过 `AUDITOR_LENS`(7 条内容审计探针)+ 写作结构模板;后一版换成"摸用户语气画像 +
AI_TELLS(Wikipedia 'Signs of AI writing' 6 类形式 tell 密度自检)"。都实测过 —— 那些约束本身
就是均值化锚点,草稿读起来仍像"很懂规范的 AI 写的"。整套废了,见 `scripts/lib/draft.js` 头注
的演化史。

## 隐私 / 体积

- `index.jsonl` 只存**元数据 + AI 生成的摘要**,**不复制原始对话内容**
- 单条 ~1 KB,千条会话约 1 MB
- 原文在 `~/.claude/projects/`,通过 sessionId 回查
- 数据落在用户 home 下的 `~/.ai-best-practice/`(可用 `AIBP_DATA_DIR` 覆盖),
  插件目录不再放数据,升级插件不会丢历史。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AIBP_SCORE_MODEL` | `claude-haiku-4-5` | 评分模型(走 `claude -p` 子进程) |
| `AIBP_CONCURRENCY` | `8` | scan 并发数 |
| `AIBP_DATA_DIR` | `~/.ai-best-practice` | 数据根目录(含 `data/` / `weekly/` / `logs/`) |
| `AIBP_SCORE_TIMEOUT_MS` | `180000` | 单条评分超时 |
| `AIBP_NO_HEURISTIC` | unset | 设为 `1` 关掉本地启发式预筛(所有会话都走 Haiku) |

> 起草用的不是子进程,所以没有 `AIBP_DRAFT_MODEL`:`/ai-practice-pick` 在你当前那个 Claude Code
> 会话里直接写最终版本,等于"主对话的模型就是起草模型"。你切换 `/model` 就切了起草模型。

## 关键设计

- **评分走子进程,起草不走**:scoring(Haiku)走 `claude -p` 子进程(后台、批量、便宜);drafting 走**主对话本身**(`/ai-practice-pick` 在你当前会话里直接产出 markdown),复用主会话的模型 + 1M 上下文,不再起 1M 子进程,也避开 Anthropic 长上下文 Extra Usage 计费档
- **LLM 走 claude cli**:不直接调 Anthropic API,鉴权完全复用 Claude Code,无 key 管理
- **mtime 缓存**:重复 scan 跳过未变更的 jsonl
- **本地启发式预筛**(0.1.7):`lib/heuristic.js` 在调 Haiku 之前先看一眼会话——典型闲聊/单问单答/零编辑/git 窗口内无 commit 的,直接本地打 10-15 分、零成本、跳过 Haiku。粗估能压 30-50% 的 Haiku 调用。完全关掉:`AIBP_NO_HEURISTIC=1`
- **git 证据进卡片**(0.1.7):parse-jsonl 读 cwd 的 `git log` 拿到会话时间窗口内的 commit,作为"AI 产出真的落地了"的强证据塞进 Haiku 评分卡(`gitCommitsInWindow` 字段)。比 `filesEdited` 计数靠谱得多
- **`--bare --no-session-persistence`**:防止 scorer 自己的会话被 hook 递归索引

## 故障排除

- hook 没触发:确认 plugin 已安装(`/plugin list` 能看到 `ai-best-practice@ai-bp`),或本地开发时启动带 `--plugin-dir`
- 评分超时:大会话(jsonl > 500KB)可能需要把 `AIBP_SCORE_TIMEOUT_MS` 调到 300000
- `claude -p` 返回 is_error:看 `~/.ai-best-practice/logs/ai-best-practice.log` 末尾 stderr
- 索引为空:跑一次 `/ai-practice-scan`(空 index 等 hook 慢慢攒会很久)
- 想排除某些目录:编辑 `scripts/scan.js` 顶部的 `EXCLUDE_PREFIXES` 数组

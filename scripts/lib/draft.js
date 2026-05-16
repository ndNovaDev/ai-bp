// 周报起草的辅助常量和工具函数。
//
// 这个模块**不再有 prompt 模板** — 起草整个工作流(收集证据 → 采访 → 终稿)
// 完全由主对话 Claude 自己驱动。slash command 在 commands/ai-practice-pick.md
// 里描述工作流,主 Claude 用自己的工具(Read / Bash git)按需收集证据,
// 边看边判断"够了"。
//
// 这个文件只暴露主 Claude 用得上的"裸物料",分两类 lens:
//   AUDITOR_LENS  — 内容审计:7 条探针(真实性 / 难度 / 成熟度 / 沉淀 / 杠杆 / 诚实 / 完整度)
//   AI_TELLS      — 形式审计:6 类 LLM 结构性 tell(否定式对仗 / 三项并列 / -ing 挂尾 /
//                  inline-header lists / outline 模具 / 向均值回归)
//   titleToSlug   — 案例名 → 文件名 slug
//   extractTitle  — 从 markdown 反推 H1
//
// 假想敌:公司内部的"AI 最佳实践审计 AI",它从全公司每周成百上千份提交里挑真金,
// 不奖励"会写报告的人"。见 AUDITOR_LENS。AI_TELLS 来自 Wikipedia "Signs of AI writing"
// (en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)— 不在词层面拦截,在句法/段落
// 层面拦截,所以才需要跟 AUDITOR_LENS 平级独立 export。

const AUDITOR_LENS = `你写的这份周报会被一个独立的"AI 最佳实践审计 AI"逐条评估。它的 7 条探针你必须心里有数:
1. 真实性:它在找编造痕迹、套话、空 artifact,以及 **generic positive language**(向均值回归 — 用抽象拔高替换具体事实,例:"被严重低估的数据源"、"用了就回不去"这类)。引用具体 commit hash / sessionId / 文件路径 / 数字(扫了 N 个 session 花了 $X、迭代 M 次),但不复述其内容。形式层面的反向均值回归见 AI_TELLS 第 6 条。
2. 问题难度:它会识破伪需求("自动化打开文档"那种)。用"如果不做会怎样"的反事实交代代价(时间/质量/重复劳动)。
3. AI 协作成熟度:它在判断作者是"把 AI 当聊天"还是"把 AI 当工程师"。要让叙事里自然出现 plan → 分解 → 工具编排 → 验证的链路,不要强调"我让 AI 做了 X"。
4. 沉淀深度:它在区分一次性脚本和可分发 artifact。是否产出 plugin / skill / hook / 文档,且别人能直接复用。
5. 杠杆:它在找这次产出对未来工作的复利。一两句点到"下次类似场景的边际成本",不画饼,只指出机制。
6. 成本诚实度:它对虚报 ROI、口号化收益敏感。量化项老老实实写区间或"未量化",不编百分比。
7. 故事完整度:它会扣**伪完整**的分 — 为了凑结构把 R(结果)编出来、把 T(任务)拔高、给"本次未做"也填一段,这些比塌方更糟。这次有什么写什么,没量化老老实实写"未量化",根本没做的部分不要出现在文章里。STAR 不是必须的结构,只是一个"想清楚没"的检查清单。

写作风格要求:
- 论文级:每句话能被审计 AI 单独抠出来评估,经得起推敲。
- 平实白话,主体写散文段落而不是 bullet 列表。
- 中文表达,避免翻译腔。不要"使用了 X 工具"、"调用了 Y"、"通过 X 完成 Y" 这种 LLM 句式。
- 隐性表达成熟度和杠杆,不要喊口号。"未来这件事的边际成本从 N 小时变成 N 分钟"比"极大地提升了效率"强。
- 不用 emoji。不用独立的 \`---\` 分隔线。`;

const AI_TELLS = `LLM 写作有几个**结构性指纹**,密度一上来读者立刻识别"AI 写的"。即使你没用 LLM 套话词,这些**句法/段落层面的 tell** 仍然会出戏。写之前心里装着这份清单,写完读一遍数密度。

来源:Wikipedia "Signs of AI writing"(WP:AIPARALLEL / WP:RO3 / WP:SUPERFICIAL / WP:AILIST 等)。

判别原则:**不是"有没有",是"密度"**。单个偶发可以,密度上来就是 tell。

1. **否定式对仗(最强 tell)**:
   "不是 X 而是 Y" / "不仅 X 还 Y" / "不只是 X 也不只是 Y" / "X 不是 Y,而是 Z"
   人也偶尔用,但 LLM 一段一两个,密度异常。**全篇至多 1 处**。
   反例:"不是平台级产出,但也不只是个一次性脚本"
   写法:直接讲 — "这是个个人工具,跑得稳"。

2. **三项并列(rule of three)**:
   "形容词、形容词、形容词" 或 "短语、短语、短语"。LLM 用三项让浅薄分析显得 comprehensive。
   **散文段落里最多 2 项**(真清单形式不限)。
   反例:"动机、痛点强度、走过的弯路、ROI"(四项也是同结构)
   写法:讲一两个具体的就够 — "主要看动机和痛点强度"。

3. **-ing 短语挂尾(superficial analyses)**:
   句末挂 "...,体现了 X / 凸显了 Y / 折射出 Z / 印证了 W / 标志着 V / 展现出 U / 反映出 T"。
   **整类禁用**。陈述事实就停,不要给意义性总结。
   反例:"...完整的 plugin / hook / marketplace 这套机制走完一遍,后面要做类似工具的成本会低不少"
   (尾巴是个超凡拔高 — 对杠杆做 superficial analysis)
   写法:把"成本下降多少"具体讲(N 小时 → N 分钟),或者干脆不讲。

4. **Inline-header vertical lists**(\`- **关键词**: 说明文\`):
   每条 bullet 开头加粗一个标签再写说明。这种格式本身是 LLM 指纹。
   **散文段落里禁用**;只有真正"清单/表格类"信息才用。
   写法:把每条的标签内化进句子开头("先做 X 因为...,然后 Y 是因为...")。

5. **Outline 模具**:
   固定的 "Challenges and Future Prospects" 收尾节(中文 "还差什么 / ROI 怎么看")。
   模型见过太多类似语料,本能地补上这两节。
   **没明确想清楚的不写**;宁可文章主体讲完就结束。

6. **Regression to the mean(向均值回归)** — 上面 5 条的根:
   LLM 把 specific, unusual, nuanced facts 替换成 generic, positive, important-sounding 的话。
   反例:"OKR 周报省事" → "从'不会用'到'用了就回不去'的差别"
        "索引到 346 个 session,扫一次约 $10" → "被严重低估的数据源"
   写法:每写一个抽象拔高的句子,问自己 — 这能换成具体事实吗?能就换。

**自检方法**(写完读一遍,主观判断,不做程序化重写):
- 一段里 0-1 个 tell:正常,放过
- 一段里 ≥ 2 个 tell:这段重写
- 全文累计 ≥ 5 个 tell:整体气质是 LLM,主体段落都需要重新组织`;

function titleToSlug(title) {
  if (!title) return 'untitled';
  // 保留中英数字,其余空白和标点都成连字符
  let s = String(title).trim().toLowerCase();
  s = s.replace(/[\s　]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}\-]/gu, '');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s) return 'untitled';
  return s.length > 60 ? s.slice(0, 60).replace(/-+$/, '') : s;
}

function extractTitle(markdown) {
  const m = /^#\s+(.+)$/m.exec(markdown || '');
  return m ? m[1].trim() : 'untitled';
}

module.exports = {
  AUDITOR_LENS,
  AI_TELLS,
  titleToSlug,
  extractTitle,
};

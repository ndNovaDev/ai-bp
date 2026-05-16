// 周报起草的辅助常量和工具函数。
//
// 这个模块**不再有 prompt 模板,也不再有内容审计约束** — 起草整个工作流
// (摸用户语气 → 收集证据 → 采访 → 终稿)完全由主对话 Claude 自己驱动。
// slash command 在 commands/ai-practice-pick.md 里描述工作流,主 Claude 用
// 自己的工具(Read / Bash / grep / jq)按需做事,边看边判断"够了"。
//
// 这个文件只暴露主 Claude 用得上的两样裸物料:
//   AI_TELLS      — 形式审计:6 类 LLM 结构性 tell(否定式对仗 / 三项并列 / -ing 挂尾 /
//                  inline-header lists / outline 模具 / 向均值回归)
//                  来源 Wikipedia "Signs of AI writing"
//                  (en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)— 不在词
//                  层面拦截,在句法/段落层面拦截。判别原则:不是"有没有",是"密度"。
//   titleToSlug   — 案例名 → 文件名 slug
//   extractTitle  — 从 markdown 反推 H1
//
// 历史:之前还有一份 AUDITOR_LENS(7 条内容审计探针),配着一坨写作风格示例和结构模板
// (开篇/结论先讲/方案演进 三段式)。实践下来这些约束让草稿读起来仍然像"很懂规范的 AI
// 写的",而不是像用户本人写的 — 因为约束本身就是均值化的。换成"先采样用户真实发言、
// 摸出语气画像,再让主 Claude 照着画像写"之后,草稿才开始有个人指纹。
// AI_TELLS 保留是因为它只拦形式问题,跟"模仿谁"正交。

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
  AI_TELLS,
  titleToSlug,
  extractTitle,
};

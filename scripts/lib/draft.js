// 周报起草的辅助常量和工具函数。
//
// 这个模块不持有 prompt 模板,不做内容审计,也不做形式自检 — 起草整个工作流
// (取证 → 采访 → 大纲 → 段落 → 砍句 → 砍段 → 反推大纲对比 → 落盘)完全由
// 主对话 Claude 自己驱动。slash command 在 commands/ai-practice-pick.md 描述。
//
// 这个文件只暴露三样裸物料:
//   STYLE_GUIDE   — 短风格方向锚(3-8 行)。只指方向("按优秀技术文档/指南的标准写"),
//                  刻意不列具体 do/don't。起草段落前主 Claude 把它读进上下文。
//   titleToSlug   — 案例名 → 文件名 slug
//   extractTitle  — 从 markdown 反推 H1
//
// 演化史 — 这个文件经历了三轮"控制起草质量"的尝试,记下来防止 future-self 走回头路:
//
//   v1: AUDITOR_LENS(7 条内容审计探针) + BANNED_PHRASES(LLM 套话黑名单) +
//       写作结构模板(开篇 / 结论先讲 / 方案演进 三段套)。
//       问题:让草稿读起来像"很懂规范的 AI 写的"。约束本身就是均值化锚点。
//
//   v2: 摸用户语气画像(从历史 jsonl 采用户真实发言,画句长 / 标点 / 中英混杂 /
//       立场强度等特征) + AI_TELLS(Wikipedia "Signs of AI writing" 6 类形式 tell
//       的密度自检)。
//       问题有两条:
//       a) 摸语气错位:聊天和写作是两种语域,拿聊天采样去当文章语气锚,从根上就
//          跟"写出像作者的文章"这个目标对不上。
//       b) AI_TELLS 是事后形式补救:能拦"不要写'不是 X 而是 Y'",拦不住结构性的
//          AI 思考方式(从大纲到段落到收尾,整体气质仍是 LLM)。
//
//   v3(当前): 预设结构而非事后审查。
//       套 Jordan Peterson Essay Writing Guide(大纲先行 → 段落生成 → 砍句 →
//       砍段 → 反推大纲做 sanity check),通过修剪让作者真正想清楚。
//       语域只有一份**短** STYLE_GUIDE,3-8 行,只指方向不列规则。
//       一旦在 STYLE_GUIDE 里列具体 do/don't 或贴示例,就回到 v1/v2 的失败模式 ——
//       规则本身变成均值化锚点。测试里把行数上限锁死(test/draft.test.js)。

const STYLE_GUIDE = `按"优秀技术文档 / 优秀技术指南"的标准写。

读者是跟你同 level 的工程师同事 — 他要看的是这件事是怎么做出来的、为什么这么选、值不值。

写完读一遍,问自己:把它放进我读过的最好的技术文档/指南里,丢不丢人? 不丢就过。`;

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
  STYLE_GUIDE,
  titleToSlug,
  extractTitle,
};

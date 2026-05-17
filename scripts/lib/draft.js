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
// 演化史 — 这个文件经历了几轮"控制起草质量"的尝试,记下来防止 future-self 走回头路。
// 全部失败模式可归为一句:**列规则本身就是均值化锚点**。
//
//   v1: AUDITOR_LENS(7 条内容审计探针) + BANNED_PHRASES(LLM 套话黑名单) +
//       写作结构模板(开篇 / 结论先讲 / 方案演进 三段套)。
//       → 产出读起来像"很懂规范的 AI 写的"。
//
//   v2: 摸用户语气画像(从历史 jsonl 采聊天发言) + AI_TELLS(Wikipedia "Signs of
//       AI writing" 6 类形式 tell 密度自检)。
//       → 聊天和写作两种语域,采样语气画像从根上错位;AI_TELLS 是事后形式补救,
//         拦不住结构性的 AI 思考方式。
//
//   v3.x: 在 Peterson 流程之上加 5h 句式打散(每个 sub-sentence 强制换起头/动词/
//         修辞/句式)+ 5b 大纲长禁止清单 + 6 路角色 reviewer + 句尾"作者站出来"
//         判定 + 结构必须随机抽选清单。
//       → 同一个失败模式:规则越列越多,规则本身变成新的均值化锚点。
//         5h 甚至自带"能从改动里抠出 SOP 就推倒重做"的自指悖论。
//
//   v3(当前): 预设结构 + 短 STYLE_GUIDE + 4 路 peer review,**不再列具体规则**。
//       套 Jordan Peterson Essay Writing Guide(大纲先行 → 段落生成 → 砍句 →
//       砍段 → 反推大纲做 sanity check),通过修剪让作者真正想清楚。
//       4 路 subagent peer review(AI 审查员 / 同级同事+文档专家 / 技术专家 /
//       公司老板)兜底,任何一路"不合格"就改完再发第二轮。
//       STYLE_GUIDE 锁 3-8 行,只指方向(test/draft.test.js 锁了上限)。

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

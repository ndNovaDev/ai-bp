// 周报起草的辅助常量和工具函数。
//
// 这个模块**不再有 prompt 模板** — 起草整个工作流(收集证据 → 出 STAR + 4 题 → 采访
// → 终稿 → 后置检测)完全由主对话 Claude 自己驱动。slash command 在 commands/
// ai-practice-pick.md 里描述工作流,主 Claude 用自己的工具(Read / Bash git)按需收集证据,
// 边看边判断"够了",不再被动消化一个 JSON.stringify 出来的 80-150KB 大证据包。
//
// 这个文件只暴露主 Claude 用得上的"裸物料":
//   AUDITOR_LENS    — 假想敌审计 AI 的 7 条探针(主 Claude Read 进上下文当指令)
//   BANNED_PHRASES  — LLM 套路短语黑名单
//   detectBanned    — 终稿落盘后跑一次,命中触发主 Claude 重写
//   titleToSlug     — 案例名 → 文件名 slug
//   extractTitle    — 从 markdown 反推 H1
//
// 假想敌:公司内部的"AI 最佳实践审计 AI",它从全公司每周成百上千份提交里挑真金,
// 不奖励"会写报告的人"。见 AUDITOR_LENS。

const AUDITOR_LENS = `你写的这份周报会被一个独立的"AI 最佳实践审计 AI"逐条评估。它的 7 条探针你必须心里有数:
1. 真实性:它在找编造痕迹、套话、空 artifact。引用具体 commit hash / sessionId / 文件路径,但不复述其内容。
2. 问题难度:它会识破伪需求("自动化打开文档"那种)。用"如果不做会怎样"的反事实交代代价(时间/质量/重复劳动)。
3. AI 协作成熟度:它在判断作者是"把 AI 当聊天"还是"把 AI 当工程师"。要让叙事里自然出现 plan → 分解 → 工具编排 → 验证的链路,不要强调"我让 AI 做了 X"。
4. 沉淀深度:它在区分一次性脚本和可分发 artifact。是否产出 plugin / skill / hook / 文档,且别人能直接复用。
5. 杠杆:它在找这次产出对未来工作的复利。一两句点到"下次类似场景的边际成本",不画饼,只指出机制。
6. 成本诚实度:它对虚报 ROI、口号化收益敏感。量化项老老实实写区间或"未量化",不编百分比。
7. 故事完整度:它会扣 STAR 塌方(只剩 Action,没 Task 和 Result)的分。四段都要齐全,本次没做的段直接写"本次未做"。

写作风格要求:
- 论文级:每句话能被审计 AI 单独抠出来评估,经得起推敲。
- 平实白话,主体写散文段落而不是 bullet 列表。STAR 四段以小标题分。
- 中文表达,避免翻译腔。不要"使用了 X 工具"、"调用了 Y"、"通过 X 完成 Y" 这种 LLM 句式。
- 隐性表达成熟度和杠杆,不要喊口号。"未来这件事的边际成本从 N 小时变成 N 分钟"比"极大地提升了效率"强。
- 不用 emoji。不用独立的 \`---\` 分隔线。`;

// 这些短语命中就触发 finalize 重写一次。基于实际看到的 LLM 套路梳理。
const BANNED_PHRASES = [
  '使用了',
  '调用了',
  '可以说',
  '在一定程度上',
  '总的来说',
  '综上所述',
  '极大地',
  '大大地',
  '众所周知',
  '不可否认',
];

function detectBanned(markdown) {
  const hits = [];
  for (const p of BANNED_PHRASES) {
    if (markdown.includes(p)) hits.push(p);
  }
  return hits;
}

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
  BANNED_PHRASES,
  detectBanned,
  titleToSlug,
  extractTitle,
};

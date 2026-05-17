// 周报落盘的路径/标题工具。起草本身完全由主对话驱动,本模块不持有任何 prompt。
// 历代风格控制全部证伪(STYLE_GUIDE / AUDITOR_LENS / AI_TELLS / Peterson 多步骤 / 多路 peer review / 句式打散 / 摸语气画像),
// 教训:列负面规则 = 均值化锚点。当前方案在 commands/ai-practice-pick.md 步 5,只列四条正向方向(王小波口吻 / 金字塔原理 / 知识诅咒 guard / 读者画像)
// + 一条硬约束(只锚 user 原话,不锚 Haiku 摘要)。详见 git log 0.1.20–0.1.34。

function titleToSlug(title) {
  if (!title) return 'untitled';
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
  titleToSlug,
  extractTitle,
};

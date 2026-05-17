// 周报落盘的路径/标题工具。起草本身完全由主对话驱动,本模块不持有任何 prompt。
// v1-v3 历代风格控制尝试均被证伪(STYLE_GUIDE / AUDITOR_LENS / AI_TELLS / Peterson 工序 / 4 路 reviewer),见 git log。

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

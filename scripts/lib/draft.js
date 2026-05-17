// 周报落盘的路径/标题工具。起草本身完全由主对话驱动,本模块不持有任何 prompt。
//
// 历代风格控制大多证伪(STYLE_GUIDE / AUDITOR_LENS / AI_TELLS / Peterson 多步骤 / 多路 peer review / 摸语气画像)。
// 教训:列负面规则、列变换维度 = 均值化锚点。
//
// 当前方案在 commands/ai-practice-pick.md 步 5 + 步 6:
//   步 5 第一版:四条正向方向(王小波口吻 / 金字塔原理 / 知识诅咒 guard / 读者画像)
//   步 6 打散  :逐子句重写,随机长度 + 随机句式 + 王小波口吻,唯一硬约束是通顺。不列变换维度。
//   隐性硬约束 :只锚 user 原话,不锚 Haiku 摘要。
//
// 步 6 表面看像 v3.x 那版"5h 句式打散"复活,但关键差异:
//   v3.x: 列了"换起头/动词/修辞/句式"四个具体维度 + "能抠出 SOP 就推倒重做"自指悖论 → 失败
//   现在: 只一条"通顺"硬约束,变换维度让模型自己随机
//
// 详见 git log 0.1.20–0.1.35。

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

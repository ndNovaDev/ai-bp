// 数据落盘位置。从插件目录搬到 ~/.claude/ai-best-practice/,
// 避免插件 marketplace 更新时 data/ 和 weekly/ 被一起覆盖掉。
// 可用 AIBP_DATA_DIR 覆盖。

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATA_DIR = path.join(process.env.HOME, '.claude', 'ai-best-practice');
const DATA_DIR = process.env.AIBP_DATA_DIR || DEFAULT_DATA_DIR;

const INDEX_PATH = path.join(DATA_DIR, 'data', 'index.jsonl');
const WEEKLY_DIR = path.join(DATA_DIR, 'weekly');

// 一次性迁移:把 0.1.1 之前留在插件目录里的旧数据搬过来。
// 只有当新位置还不存在、且旧位置确实有东西时才动手,避免覆盖已迁移的数据。
function migrateLegacyOnce() {
  try {
    const legacyIndex = path.join(PLUGIN_ROOT, 'data', 'index.jsonl');
    if (fs.existsSync(legacyIndex) && !fs.existsSync(INDEX_PATH)) {
      fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
      fs.renameSync(legacyIndex, INDEX_PATH);
    }
    const legacyWeekly = path.join(PLUGIN_ROOT, 'weekly');
    if (fs.existsSync(legacyWeekly) && fs.statSync(legacyWeekly).isDirectory()) {
      const entries = fs.readdirSync(legacyWeekly);
      if (entries.length > 0) {
        fs.mkdirSync(WEEKLY_DIR, { recursive: true });
        for (const f of entries) {
          const src = path.join(legacyWeekly, f);
          const dst = path.join(WEEKLY_DIR, f);
          if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        }
      }
    }
  } catch {
    // 迁移是 best-effort,失败不影响主流程
  }
}

migrateLegacyOnce();

module.exports = { DATA_DIR, INDEX_PATH, WEEKLY_DIR, PLUGIN_ROOT };

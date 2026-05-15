// 数据 / 日志 / 周报落盘位置 — 全部在 ~/.ai-best-practice/ 下。
// 故意不放在 ~/.claude/ 里:那个目录被 claude CLI 用 com.apple.provenance 标记成了
// "Anthropic 团队" 的应用数据,本插件由 node(Volta 团队签名)运行,跨 team 写入
// 会反复触发 macOS App 管理弹框。详见 commit 信息和 CLAUDE.md 的硬规矩。
//
// 可用 AIBP_DATA_DIR 覆盖根目录。
//
// 目录结构:
//   ~/.ai-best-practice/
//   ├── data/index.jsonl
//   ├── weekly/<期号>-<slug>.md
//   └── logs/ai-best-practice.log

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.HOME;
const DEFAULT_DATA_DIR = path.join(HOME, '.ai-best-practice');
const DATA_DIR = process.env.AIBP_DATA_DIR || DEFAULT_DATA_DIR;

const INDEX_PATH = path.join(DATA_DIR, 'data', 'index.jsonl');
const WEEKLY_DIR = path.join(DATA_DIR, 'weekly');
const LOG_PATH = path.join(DATA_DIR, 'logs', 'ai-best-practice.log');

// 历次默认位置,按"越早越靠后"列出。迁移时按顺序找,第一个有内容的就搬到新位置。
const LEGACY_INDEX_PATHS = [
  path.join(HOME, '.claude', 'ai-best-practice', 'data', 'index.jsonl'), // 0.1.2 - 0.1.5
  path.join(PLUGIN_ROOT, 'data', 'index.jsonl'),                          // < 0.1.2
];
const LEGACY_WEEKLY_DIRS = [
  path.join(HOME, '.claude', 'ai-best-practice', 'weekly'),
  path.join(PLUGIN_ROOT, 'weekly'),
];
const LEGACY_LOG_PATHS = [
  path.join(HOME, '.claude', 'logs', 'ai-best-practice.log'),
];

function migrateLegacyOnce() {
  try {
    // index
    if (!fs.existsSync(INDEX_PATH)) {
      for (const legacy of LEGACY_INDEX_PATHS) {
        if (fs.existsSync(legacy)) {
          fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
          fs.renameSync(legacy, INDEX_PATH);
          break;
        }
      }
    }
    // weekly
    for (const legacy of LEGACY_WEEKLY_DIRS) {
      if (!fs.existsSync(legacy)) continue;
      const stat = fs.statSync(legacy);
      if (!stat.isDirectory()) continue;
      const entries = fs.readdirSync(legacy);
      if (entries.length === 0) continue;
      fs.mkdirSync(WEEKLY_DIR, { recursive: true });
      for (const f of entries) {
        const src = path.join(legacy, f);
        const dst = path.join(WEEKLY_DIR, f);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
    }
    // log
    if (!fs.existsSync(LOG_PATH)) {
      for (const legacy of LEGACY_LOG_PATHS) {
        if (fs.existsSync(legacy)) {
          fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
          fs.renameSync(legacy, LOG_PATH);
          break;
        }
      }
    }
  } catch {
    // 迁移是 best-effort,失败不影响主流程
  }
}

migrateLegacyOnce();

module.exports = { DATA_DIR, INDEX_PATH, WEEKLY_DIR, LOG_PATH, PLUGIN_ROOT };

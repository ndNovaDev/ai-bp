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
//   ├── weekly/<期号>-<slug>/<期号>-<slug>.md   # 每篇一个独立文件夹,配图 / 源文件并存
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

// 0.1.49: weekly 从扁平 <slug>.md 改成 <slug>/<slug>.md 一文件夹一案例。
// 把 WEEKLY_DIR 下散落的文件按 basename(去扩展名)归组,各自塞进同名子文件夹。
// 这样 .md / .excalidraw / .png / .pdf 等同名兄弟自动并入一个案例文件夹。
function migrateFlatWeeklyToFolders() {
  try {
    if (!fs.existsSync(WEEKLY_DIR)) return;
    const entries = fs.readdirSync(WEEKLY_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith('.')) continue;
      const base = e.name.replace(/\.[^.]+$/, '') || e.name;
      if (!base) continue;
      const folder = path.join(WEEKLY_DIR, base);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      const src = path.join(WEEKLY_DIR, e.name);
      const dst = path.join(folder, e.name);
      if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    }
  } catch {
    // 同样 best-effort
  }
}

migrateLegacyOnce();
migrateFlatWeeklyToFolders();

module.exports = { DATA_DIR, INDEX_PATH, WEEKLY_DIR, LOG_PATH, PLUGIN_ROOT };

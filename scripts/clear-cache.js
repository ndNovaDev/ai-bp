#!/usr/bin/env node
// 清空打分缓存(index.jsonl)。weekly/ 输出和 logs/ 不动。
// 给 /ai-practice-clear 用,不直接给人用 — 所以输出走 JSON。
//
// 用法:
//   node clear-cache.js --info   # 只输出 JSON 预览,不删
//   node clear-cache.js --clear  # 删

const fs = require('fs');
const { INDEX_PATH } = require('./lib/paths');

function info() {
  if (!fs.existsSync(INDEX_PATH)) {
    return { exists: false, rows: 0, sizeBytes: 0, path: INDEX_PATH };
  }
  const content = fs.readFileSync(INDEX_PATH, 'utf8');
  const rows = content.split('\n').filter((l) => l.trim()).length;
  const stat = fs.statSync(INDEX_PATH);
  return { exists: true, rows, sizeBytes: stat.size, path: INDEX_PATH };
}

const mode = process.argv[2] || '--info';
if (mode === '--info') {
  process.stdout.write(JSON.stringify(info()));
} else if (mode === '--clear') {
  const before = info();
  if (before.exists) fs.unlinkSync(INDEX_PATH);
  process.stdout.write(JSON.stringify({ deleted: before.exists, ...before }));
} else {
  console.error('Usage: node clear-cache.js [--info|--clear]');
  process.exit(1);
}

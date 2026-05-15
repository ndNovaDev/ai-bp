#!/usr/bin/env bash
# Stop hook 入口。
# stdin 是一个 JSON,含 transcript_path、session_id、cwd、hook_event_name 等。
# 我们把 transcript_path 提出来,后台异步喂给 scan-session.js,然后立刻 exit 0。
# 这样不阻塞用户对话退出,失败也不打扰主流程。

set -euo pipefail

# 跟 scripts/lib/paths.js 对齐:日志一律落在 ~/.ai-best-practice/ 下,
# 别写进 ~/.claude/(那目录由 claude CLI 用 com.apple.provenance 锁了团队,
# node 跨团队写会反复触发 macOS App 管理弹框)。AIBP_DATA_DIR 可覆盖根目录。
LOG="${AIBP_DATA_DIR:-$HOME/.ai-best-practice}/logs/ai-best-practice.log"
mkdir -p "$(dirname "$LOG")"

# 从 stdin 读 JSON
PAYLOAD=$(cat)

# 不做 cwd 过滤:所有会话都入库,由 Haiku 评分决定含金量。
# 取 transcript_path,如缺失则退出
TRANSCRIPT=$(printf '%s' "$PAYLOAD" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).transcript_path||"")}catch{}})' 2>/dev/null || echo "")
if [ -z "$TRANSCRIPT" ]; then
  echo "[$(date -u +%FT%TZ)][hook] empty transcript_path" >> "$LOG"
  exit 0
fi
if [ ! -f "$TRANSCRIPT" ]; then
  echo "[$(date -u +%FT%TZ)][hook] transcript missing: $TRANSCRIPT" >> "$LOG"
  exit 0
fi

# 后台异步,完全脱离当前 session 的 stdio
(
  nohup node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-session.js" "$TRANSCRIPT" \
    >> "$LOG" 2>&1 &
) >/dev/null 2>&1

exit 0

#!/usr/bin/env bash
# AI-dashboard — Claude Code "Stop" hook.
#
# Installed as: $HOME/.claude/hooks/ai-dashboard-stop.sh  (see settings snippet).
# Reads the hook JSON from stdin, builds a short task label, and pings the
# Worker /notify endpoint so the dashboard shows "Claude Code finished".
#
# HARD RULE: this hook must NEVER block or fail Claude Code. It always exits 0,
# even on malformed input or network failure.
#
# Placeholders __WORKER_URL__ / __NOTIFY_SECRET__ are substituted by the orchestrator.

set +e

WORKER_URL="__WORKER_URL__"
NOTIFY_SECRET="__NOTIFY_SECRET__"

# Read all of stdin (the hook payload).
INPUT="$(cat 2>/dev/null)"
[ -z "$INPUT" ] && exit 0

# Extract fields. Prefer jq; fall back to python3; if neither, give up quietly.
LAST_MSG=""
CWD=""
STOP_REASON=""

if command -v jq >/dev/null 2>&1; then
  LAST_MSG="$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // .lastAssistantMessage // ""' 2>/dev/null)"
  CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)"
  STOP_REASON="$(printf '%s' "$INPUT" | jq -r '.stop_reason // .stopReason // ""' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  read -r LAST_MSG CWD STOP_REASON < <(printf '%s' "$INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
def g(*keys):
    for k in keys:
        v = d.get(k)
        if v: return str(v)
    return ""
msg = g("last_assistant_message", "lastAssistantMessage").replace("\n", " ").replace("\t", " ")
cwd = g("cwd")
sr  = g("stop_reason", "stopReason")
# tab-separated, single line
print("%s\t%s\t%s" % (msg, cwd, sr))
' 2>/dev/null | awk -F'\t' '{print $1"\n"$2"\n"$3}')
else
  exit 0
fi

# Skip notification for intermediate tool-use stops.
if [ "$STOP_REASON" = "tool_use" ]; then
  exit 0
fi

# Project name = basename of cwd.
PROJECT="unknown"
[ -n "$CWD" ] && PROJECT="$(basename "$CWD")"

# First line of the message, trimmed to ~120 chars.
FIRST_LINE="$(printf '%s' "$LAST_MSG" | head -n1)"
TRUNC="$(printf '%s' "$FIRST_LINE" | cut -c1-120)"
[ "${#FIRST_LINE}" -gt 120 ] && TRUNC="${TRUNC}…"

TASK="${PROJECT}: ${TRUNC}"

# Build JSON body safely (jq if present, else naive escaping).
if command -v jq >/dev/null 2>&1; then
  BODY="$(jq -n --arg t "$TASK" '{tool:"Claude Code", account:"Claude", task:$t}' 2>/dev/null)"
else
  ESC="$(printf '%s' "$TASK" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  BODY="{\"tool\":\"Claude Code\",\"account\":\"Claude\",\"task\":\"${ESC}\"}"
fi

# Fire and forget — never let failure surface.
curl -s --max-time 5 \
  -X POST "${WORKER_URL%/}/notify" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NOTIFY_SECRET}" \
  -d "$BODY" >/dev/null 2>&1

exit 0

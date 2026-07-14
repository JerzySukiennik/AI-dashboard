#!/usr/bin/env bash
# AI-dashboard — Codex CLI notify hook.
#
# Codex invokes the notify program with a single final argument: a JSON string,
# e.g.  {"type":"agent-turn-complete","turn-id":"12345"}
# The payload is minimal. Some Codex versions may also include
# "last-assistant-message" or "input_messages" — we use those for the task label
# when present, otherwise fall back to "Task finished (turn <id>)".
#
# Install as: /Users/jurek/.codex/ai-dashboard-notify.sh
# Enable in ~/.codex/config.toml:
#   notify = ["/Users/jurek/.codex/ai-dashboard-notify.sh"]
#
# Always exits 0 — a failing notify must not disturb Codex.
#
# Placeholders __WORKER_URL__ / __NOTIFY_SECRET__ are substituted by the orchestrator.

set +e

WORKER_URL="__WORKER_URL__"
NOTIFY_SECRET="__NOTIFY_SECRET__"

# Codex passes the JSON as the last argument; also accept stdin as a fallback.
PAYLOAD="${!#}"
if [ -z "$PAYLOAD" ] || [ "${PAYLOAD:0:1}" != "{" ]; then
  PAYLOAD="$(cat 2>/dev/null)"
fi
[ -z "$PAYLOAD" ] && exit 0

TURN_ID=""
LAST_MSG=""

if command -v jq >/dev/null 2>&1; then
  TURN_ID="$(printf '%s' "$PAYLOAD" | jq -r '."turn-id" // .turn_id // .turnId // ""' 2>/dev/null)"
  LAST_MSG="$(printf '%s' "$PAYLOAD" | jq -r '."last-assistant-message" // .last_assistant_message // (.input_messages // [] | if type=="array" then (.[-1] // "") else . end) // ""' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  read -r TURN_ID LAST_MSG < <(printf '%s' "$PAYLOAD" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
def g(*keys):
    for k in keys:
        v = d.get(k)
        if v: return v
    return ""
tid = str(g("turn-id", "turn_id", "turnId"))
msg = g("last-assistant-message", "last_assistant_message")
if not msg:
    im = d.get("input_messages")
    if isinstance(im, list) and im:
        msg = str(im[-1])
    elif isinstance(im, str):
        msg = im
msg = str(msg).replace("\n", " ").replace("\t", " ")
print("%s\t%s" % (tid, msg))
' 2>/dev/null | awk -F'\t' '{print $1"\n"$2}')
else
  exit 0
fi

# Build the task label.
if [ -n "$LAST_MSG" ]; then
  FIRST_LINE="$(printf '%s' "$LAST_MSG" | head -n1)"
  TASK="$(printf '%s' "$FIRST_LINE" | cut -c1-120)"
  [ "${#FIRST_LINE}" -gt 120 ] && TASK="${TASK}…"
else
  [ -z "$TURN_ID" ] && TURN_ID="?"
  TASK="Task finished (turn ${TURN_ID})"
fi

if command -v jq >/dev/null 2>&1; then
  BODY="$(jq -n --arg t "$TASK" '{tool:"Codex", account:"ChatGPT", task:$t}' 2>/dev/null)"
else
  ESC="$(printf '%s' "$TASK" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  BODY="{\"tool\":\"Codex\",\"account\":\"ChatGPT\",\"task\":\"${ESC}\"}"
fi

curl -s --max-time 5 \
  -X POST "${WORKER_URL%/}/notify" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NOTIFY_SECRET}" \
  -d "$BODY" >/dev/null 2>&1

exit 0

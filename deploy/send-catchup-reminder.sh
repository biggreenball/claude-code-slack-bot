#!/bin/bash
# One-shot Slack reminder for the operator-only follow-up steps left
# unfinished from the 2026-04-27 work session. Fired by transient
# slack-bridge-catchup-reminder.timer. Safe to delete after firing.
set -euo pipefail

set -a
# shellcheck disable=SC1091
source /opt/claude-slack-bridge/.env
set +a

PAYLOAD=$(python3 - <<'PY'
import json
text = (
"🟡 *Catch-up reminder — Slack bridge work-in-flight*\n\n"
"Three PRs queued, plus operator-only steps:\n\n"
"*PRs awaiting your review/merge:*\n"
"• <https://github.com/biggreenball/claude-code-slack-bot/pull/7|PR #7> — `deploy/README.md` scope-update runbook (docs only, follow-up to #6)\n"
"• <https://github.com/biggreenball/claude-code-slack-bot/pull/8|PR #8> — sanitize debug log so `SLACK_BOT_TOKEN` + `APPROVAL_HMAC_SECRET` stop leaking into journal (live fix, already deployed on TRC1)\n\n"
"*Operator steps (only you can do these):*\n"
"1. *Reinstall Slack app* at https://api.slack.com/apps → grants `groups:history` + `groups:read` (merged PR #6). Without this, thread replies still need `@`-mentions.\n"
"2. *Rotate* `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `APPROVAL_HMAC_SECRET` — all four leaked into journal history (13× each before PR #8 closed the source).\n"
"3. *Vacuum journal* after rotation: `journalctl --rotate && journalctl --vacuum-time=1s`.\n\n"
"Runbook: `/opt/claude-slack-bridge/deploy/README.md` → *Manifest / scope updates* (lands when PR #7 merges) and *Token rotation*."
)
print(json.dumps({"channel": "C0B05TYPEQH", "text": text}))
PY
)

curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-raw "$PAYLOAD" >/dev/null

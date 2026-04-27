# Roadmap — Claude Slack Bridge

Forward-looking ideas for Andy's personal Slack → Claude Code bridge on TRC1. Per project convention, items move to PUNCHLIST once scoped, and disappear from this file once shipped.

## Today

- [ ] **Rotate `SLACK_BOT_TOKEN` and `APPROVAL_HMAC_SECRET`** — both leaked into `/tmp/slack-bot.log` on 2026-04-26 before the BOT_DEBUG rename closed the source. Runbook: `deploy/README.md` → "Token rotation". A one-shot Slack reminder is scheduled for 20:31 UTC today via `rotate-token-reminder.timer`.

## Near-term

- [ ] **`/claude status` slash command** — see active sessions, working dirs, in-flight approvals, last activity per (channel, thread).
- [ ] **TTL on thread auto-approval** — currently runs forever once enabled; cap at 1 hour or 10 tool uses (per the PR-C punchlist).
- [ ] **Audit `journalctl` for any leaked env values after the rotation.**

## Mid-term

- [ ] **Stale-file cleanup on MCP startup** — orphan `.tmp` files and decision files >5min old (PR-B punchlist).
- [ ] **Pretty-print stuck-approval debugging** — the orphan-card sweep flags expired cards but doesn't tell the user which Claude session was waiting on them.
- [ ] **Test coverage for `DENIED_BASH_PATTERNS` and `DENIED_FILE_WRITE_PREFIXES`** — even a smoke test catches regex regressions (we shipped at least two patterns that didn't match what they claimed across PR-C r2 → r3).

## Architectural / north-star

- [ ] **Non-root tool execution** — currently the only true defense against a prompt-injected Claude session forging approvals or killing the bot. Tracked as the 🔴 punchlist item. Higher priority once financial data lands in scope (per `project_saas_claude_bot.md` memory).
- [ ] **Out-of-band approval confirmation** — TOTP, second-device reaction, or external webhook so the approval gate isn't co-resident with the attacker's user-id.

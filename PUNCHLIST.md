# Punchlist — Claude Slack Bridge

Small fixes and known issues. Markers: 🔴 urgent / 🟡 important / 🟢 nice-to-have / ✅ done.

## Open

### From PR-A review (PR-B + PR-C scope)

- 🟡 [PR-B] `writeApprovalDecision` has zero error handling — disk-full / dir-deleted = silent wedge. Wrap in try-catch and surface error.
- 🟡 [PR-B] Bot restart leaves orphan interactive approval cards in Slack. Sweep `/var/lib/claude-slack-bridge/approvals/` on startup and post "⏱️ timed out" updates to any cards whose decision file pre-dates this boot.
- 🟡 [PR-B] Belt-and-suspenders redundancy — `slack-handler.ts` calls both `writeApprovalDecision()` and `permissionServer.resolveApproval()` (the latter calls the former). Pick one path.
- 🟡 [PR-B] MCP subprocess startup failure surfaces as silent 5-min timeout. Detect spawn failure and surface immediately via Slack.
- 🟡 [PR-B] Audit `journalctl -u claude-slack-bridge` for any leak of `SLACK_BOT_TOKEN` / `APPROVAL_HMAC_SECRET` from spawn-args or env-dump logging.

### True boundary follow-up

- 🔴 **HMAC alone is defense-in-depth, not a real boundary.** A prompt-injected Claude tool running as the same user (root) can read `APPROVAL_HMAC_SECRET` from `/proc/<bot-pid>/environ` and forge approvals. Real fix requires out-of-band confirmation (TOTP, second-device reaction, external webhook, or running Claude tools under a non-root user). Schedule before financial data lands in scope per `project_saas_claude_bot.md`.
- 🔴 **The PR-C Bash denylist is bypassable.** `bash -c "$(echo cGtpbGwgdHN4 | base64 -d)"`, `eval`, or write-script-then-execute will all slip past the regex. The denylist raises the bar against casual prompt injection but is not a sandbox. Same architectural fix as the HMAC item — non-root tool execution.
- 🟡 **Thread auto-approval (`approve_thread_always` button) widens blast radius.** Once enabled, every subsequent gated tool in that thread runs without a card. A prompt-injected Claude session in an auto-approved thread can chain destructive ops with no human-in-the-loop. The PR-C Bash denylist still fires (good), but anything not in the denylist (Edit/Write of arbitrary paths, etc.) goes through. Consider auto-expiring auto-approval after N tools or M minutes.
- 🟡 **`mcp__postgres__query` is auto-approved** — fine while no sensitive data lives in Postgres, but the moment financials land per `project_saas_claude_bot.md`, this needs to revert to gated.

### Dead code / cleanup

- 🟢 Dead `pendingApprovals` Map field in `permission-mcp-server.ts` — orphaned after file-IPC switch.
- 🟢 Dead `formatEditTool`/`formatWriteTool`/`formatBashTool` in `slack-handler.ts` — unreachable since GATED_TOOLS suppresses them.
- 🟢 Dead `member_joined_channel` handler in `slack-handler.ts` — manifest no longer subscribes.
- 🟢 Bare `catch { /* no-op */ }` in `index.ts` global middleware — log it instead.
- 🟢 Stale `.tmp` cleanup on MCP startup (orphaned writes from crashes).
- 🟢 Stale `approval_*.json` >5min old cleanup on MCP startup.

### Other

- 🟡 `npm install` flagged 10 vulns incl. 1 critical — run `npm audit` when convenient and review before running `audit fix --force`.
- 🟢 package.json `author` field is empty; set to `Andy Hayes <trc@boundlesskc.com>` once we cut our own version bump
- 🟢 Upstream repo declares `ISC` in package.json but `MIT` in README — we normalized to MIT via our LICENSE file, consider upstreaming a PR to clean this up
- 🟢 Upstream type error in `permission-mcp-server.ts` (`as PermissionRequest`) patched locally with `as unknown as`; worth PRing upstream

## Done

- ✅ Fix hardcoded author path in `src/claude-handler.ts:65` (was `/Users/marcelpociot/...`)
- ✅ Switch to `process.cwd()`-based MCP path resolution (import.meta clashed with commonjs tsconfig)
- ✅ Fix upstream `import.meta.url` main-check in `permission-mcp-server.ts:264` to use `process.argv[1]?.includes(...)` so `tsc` build is green
- ✅ Enable `interactivity.is_enabled` in `slack-app-manifest.{json,yaml}` (was `false` — buttons wouldn't respond)
- ✅ Drop `member_joined_channel` from bot events (DM-only bot, avoids needing channels:read/groups:read/mpim:read scopes)
- ✅ Slack user allowlist via `ALLOWED_SLACK_USER_IDS` env var (fail-closed at startup, gates all 5 entry points)
- ✅ Tool allowlist defaults applied in `claude-handler.ts`: auto-approve `Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `NotebookRead`, `TodoWrite`; `Bash`, `Edit`, `Write`, `NotebookEdit`, `Task` stay gated via permission-prompt MCP
- ✅ Fix `.env.example` defaults (TRC1 `/opt/` instead of `/Users/username/Code/`, ANTHROPIC_API_KEY commented out since subscription auth is used)
- ✅ systemd unit file staged at `deploy/claude-slack-bridge.service` (not yet installed to `/etc/systemd/system/`)
- ✅ Add `LICENSE` file (MIT) — upstream had none
- ✅ Set git identity globally on TRC1 (`Andy Hayes <trc@boundlesskc.com>`)
- ✅ first end-to-end Slack approval test
- ✅ [PR-A] HMAC-sign approval decision files (defense-in-depth vs forgery)
- ✅ [PR-A] Validate approvalId regex on read + write paths (path injection guard)
- ✅ [PR-A] Approvals dir mode 0700 + decision files mode 0600
- ✅ [PR-A] Move APPROVALS_DIR `/tmp/` → `/var/lib/claude-slack-bridge/approvals/` (survives reboot via systemd `StateDirectory=`)
- ✅ Thread replies without mentions work when bot active in thread
- ✅ Read-only MCP tools (GitHub, Git, filesystem, postgres, web-search) bypass approval prompts
- ✅ "Always approve for thread" button enables auto-approval for specific threads
- ✅ Enhanced Slack Block Kit formatting with rich text blocks for better message rendering
- ✅ [PR-B] writeApprovalDecision wrapped in try-catch; failures surface ephemerally instead of silent wedge
- ✅ [PR-B] Drop redundant `permissionServer.resolveApproval()` call in slack-handler; deleted dead method on PermissionMCPServer; deleted dead `pendingApprovals` Map field
- ✅ [PR-B] Renamed our debug env var to `BOT_DEBUG` so SDK's leaky `logForDebugging` (gated on `DEBUG`) stays quiet — closes the spawn-args token leak
- ✅ [PR-C] systemd hardening: `StartLimitBurst=5` / `IntervalSec=60` (no restart-loop CPU burn), `OOMScoreAdjust=-1000`, `TasksMax=512`, `LimitNOFILE=8192`
- ✅ [PR-C] Bash denylist in permission-prompt MCP: hard-deny `pkill`/`killall`/`kill <pid>`/`systemctl <action> claude-slack-bridge`/`shutdown`/`halt`/`reboot`/`init 0`/`rm` against state or install dirs. Pre-empts thread auto-approval — even an opted-in thread can't push a self-kill through.
- ✅ [PR-C] Expanded `deploy/README.md` with first-time install, rollback, token rotation (Slack + HMAC), debugging stuck approvals, sanity checks
- :white_check_mark: first end-to-end Slack approval test

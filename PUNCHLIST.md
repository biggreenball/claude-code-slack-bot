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
- 🟡 **Thread auto-approval still has no time/count expiry.** PR-C/r2 narrowed the scope (Write/Edit/NotebookEdit/Task always card even when opted in), but Bash auto-approves indefinitely subject to denylist. Consider TTL (1h) or use-count cap (10 calls) on top.
- 🟡 **`mcp__postgres__query` is auto-approved** — fine while no sensitive data lives in Postgres, but the moment financials land per `project_saas_claude_bot.md`, this needs to revert to gated.

### Dead code / cleanup

- 🟢 Dead `pendingApprovals` Map field in `permission-mcp-server.ts` — orphaned after file-IPC switch.
- 🟢 Dead `formatEditTool`/`formatWriteTool`/`formatBashTool` in `slack-handler.ts` — unreachable since GATED_TOOLS suppresses them.
- 🟢 Dead `member_joined_channel` handler in `slack-handler.ts` — manifest no longer subscribes.
- 🟢 Bare `catch { /* no-op */ }` in `index.ts` global middleware — log it instead.
- 🟢 Stale `.tmp` cleanup on MCP startup (orphaned writes from crashes).
- 🟢 Stale `approval_*.json` >5min old cleanup on MCP startup.

### Deferred from PR-C review (small follow-ups)

- 🟢 Unit tests for `DENIED_BASH_PATTERNS` and `DENIED_FILE_WRITE_PREFIXES` — even a smoke test catches regex regressions.
- 🟢 Document StartLimitBurst recovery path in deploy/README (`systemctl reset-failed`).
- 🟢 Rollback runbook should diff `package.json` and prompt `npm install` if deps changed.
- 🟢 Replace `set -a; source .env; curl -H "Bearer $TOKEN"` sanity-check with a no-shell-history variant (e.g., `curl --oauth2-bearer @/dev/stdin <<< "$(grep ^SLACK_BOT_TOKEN= .env | cut -d= -f2)"`).
- 🟢 `journalctl --rotate` before `--vacuum-time=1s` so in-memory entries also flush.
- 🟢 systemd unit: add `WatchdogSec=` and `LogRateLimitIntervalSec=` for passive health + log-spam guard.
- 🟢 Reconcile `OOMScoreAdjust=-1000` vs `MemoryMax=2G` — currently both, pick the rationale and document.
- 🟢 Resolve `kill -9999` regex edge case (matches but is harmless syntax).

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
- ✅ [PR-C/r2] Fix HMAC rotation runbook footgun (missing `;` made `sed` run with empty `$NEWHMAC`, would wipe the secret)
- ✅ [PR-C/r2] Extend Bash denylist with `eval`, `base64 -d/-D/--decode`, and interpreter-`-c`/`-e`-with-kill/exec patterns; cap input length at 8KB to bound regex work
- ✅ [PR-C/r2] Single permissive systemctl regex (handles flags between verb and service name); dropped redundant duplicate
- ✅ [PR-C/r2] Pre-screen `Write`/`Edit`/`NotebookEdit` against `/etc/systemd/system/claude-slack-bridge.service`, `/opt/claude-slack-bridge/`, `/var/lib/claude-slack-bridge/` (no overwrite of bot install/state/unit)
- ✅ [PR-C/r2] Length-validate `APPROVAL_HMAC_SECRET >= 32 chars` in `preflightMcpSpawnPaths` (loud boot-time fail instead of cryptic 5-min approval timeout)
- ✅ [PR-C/r2] Tighten thread auto-approval: `Write`/`Edit`/`NotebookEdit`/`Task` always show approval card even in opted-in threads (Bash auto-approves under denylist)
- ✅ [PR-C/r3] Fix interpreter regex (`\b-[ce]\b` never fired because dash is non-word; switched to `\s-[ce](?=[\s'"])` lookbehind/lookahead form)
- ✅ [PR-C/r3] Resolve relative paths via `path.resolve()` before path-prefix screen — `./.env` no longer slips past the absolute-path startsWith check
- ✅ [PR-C/r3] Add `MultiEdit` to both path-screening and thread-auto-approval-exclusion lists (was overlooked in r2; uses `file_path` like Edit)
- ✅ [PR-D] Persist sessions to `/var/lib/claude-slack-bridge/sessions/` (file-per-session JSON, atomic write-then-rename, mode 0600). Survives bot restart so Claude `--resume` keeps context across systemd reloads.
- ✅ [PR-D] Backfill thread history when starting a fresh session in an existing Slack thread — pulls `conversations.replies`, filters bot UI messages, prepends as context to the prompt.
- :white_check_mark: first end-to-end Slack approval test

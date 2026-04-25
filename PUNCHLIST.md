# Punchlist — Claude Slack Bridge

Small fixes and known issues. Markers: 🔴 urgent / 🟡 important / 🟢 nice-to-have / ✅ done.

## Open

### From PR-A review (PR-B + PR-C scope)

- 🟡 [PR-B] `writeApprovalDecision` has zero error handling — disk-full / dir-deleted = silent wedge. Wrap in try-catch and surface error.
- 🟡 [PR-B] Bot restart leaves orphan interactive approval cards in Slack. Sweep `/var/lib/claude-slack-bridge/approvals/` on startup and post "⏱️ timed out" updates to any cards whose decision file pre-dates this boot.
- 🟡 [PR-B] Belt-and-suspenders redundancy — `slack-handler.ts` calls both `writeApprovalDecision()` and `permissionServer.resolveApproval()` (the latter calls the former). Pick one path.
- 🟡 [PR-B] MCP subprocess startup failure surfaces as silent 5-min timeout. Detect spawn failure and surface immediately via Slack.
- 🟡 [PR-B] Audit `journalctl -u claude-slack-bridge` for any leak of `SLACK_BOT_TOKEN` / `APPROVAL_HMAC_SECRET` from spawn-args or env-dump logging.
- 🟡 [PR-C] Add `StartLimitBurst=5` and `StartLimitIntervalSec=60` to systemd unit; install to `/etc/systemd/system/`.
- 🟡 [PR-C] Expand `deploy/README.md`: rollback runbook, health-check, token-rotation playbook (incl. `APPROVAL_HMAC_SECRET` rotation), debugging stuck approvals.

### True boundary follow-up

- 🔴 **HMAC alone is defense-in-depth, not a real boundary.** A prompt-injected Claude tool running as the same user (root) can read `APPROVAL_HMAC_SECRET` from `/proc/<bot-pid>/environ` and forge approvals. Real fix requires out-of-band confirmation (TOTP, second-device reaction, external webhook, or running Claude tools under a non-root user). Schedule before financial data lands in scope per `project_saas_claude_bot.md`.

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

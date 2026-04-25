# Punchlist — Claude Slack Bridge

Small fixes and known issues. Markers: 🔴 urgent / 🟡 important / 🟢 nice-to-have / ✅ done.

## Open

- 🟡 `npm install` flagged 10 vulns incl. 1 critical — run `npm audit` when convenient and review before running `audit fix --force`.
- 🟢 package.json `author` field is empty; set to `Andy Hayes <trc@boundlesskc.com>` once we cut our own version bump
- 🟢 Upstream repo declares `ISC` in package.json but `MIT` in README — we normalized to MIT via our LICENSE file, consider upstreaming a PR to clean this up
- 🟢 Upstream type error in `permission-mcp-server.ts:93` (`as PermissionRequest`) is patched locally with `as unknown as`; worth PRing upstream
- 🟢 Dead `member_joined_channel` handler in `slack-handler.ts:744` — orphaned now that the event isn't subscribed; can delete in a cleanup pass

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

# Punchlist — Claude Slack Bridge

Small fixes and known issues. Markers: 🔴 urgent / 🟡 important / 🟢 nice-to-have / ✅ done.

## Open

- 🟡 Decide granularity of tool allowlist before first real use (see ROADMAP near-term)
- 🟢 `.env.example` uses `/Users/username/Code/` — replace with TRC1-appropriate default (e.g., `/opt/`)
- 🟢 package.json `author` field is empty; set to `Andy Hayes <trc@boundlesskc.com>` once we cut our own version bump
- 🟢 Upstream repo declares `ISC` in package.json but `MIT` in README — we normalized to MIT via our LICENSE file, consider upstreaming a PR to clean this up

## Done

- ✅ Fix hardcoded author path in `src/claude-handler.ts:65` (was `/Users/marcelpociot/...`)
- ✅ Enable `interactivity.is_enabled` in `slack-app-manifest.{json,yaml}` (was `false` — buttons wouldn't respond)
- ✅ Add `LICENSE` file (MIT) — upstream had none
- ✅ Set git identity globally on TRC1 (`Andy Hayes <trc@boundlesskc.com>`)

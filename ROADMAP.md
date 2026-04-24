# Roadmap — Claude Slack Bridge

Forward-looking ideas for the personal Slack → Claude Code bridge on TRC1.

## Near-term

- [ ] DM allowlist restricted to Andy's Slack user ID (single-user bot)
- [ ] systemd service (`claude-slack-bridge.service`) running as root, auto-restart on failure
- [ ] Tool allowlist tuning — auto-approve safe reads (Read/Grep/Glob/LS/WebSearch), gate writes/bash
- [ ] Default working directory strategy (per-channel, per-thread, or a fixed root like `/opt/axel/`)

## Mid-term

- [ ] Session-log persistence across bot restarts (survives systemd reload without losing thread → session_id map)
- [ ] Slack-side session list / status command (`/claude status`)
- [ ] File attachment handling for images/PDFs Claude should analyze
- [ ] Structured error surfaces — if Claude crashes, post a debuggable trace back to Slack

## Long-term / "Brian-Matt fork" spin-off

- [ ] Separate codebase running as `axel` with approve/deny + tighter tool allowlist
- [ ] Multi-user support with per-user Claude Code session isolation
- [ ] Approval delegation (Brian approves, but Matt can see and comment)
- [ ] Audit log of all approve/deny decisions in pg/Supabase

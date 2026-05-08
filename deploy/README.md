# Claude Code Slack Bot — Setup & Operations

## Slack App Setup (one-time)

### 1. Create the app at api.slack.com

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. "Claude Code Bot"), pick your workspace.

### 2. Enable Socket Mode

**Settings → Socket Mode** → toggle on → generate an App-Level Token with `connections:write` scope → copy the `xapp-...` token.

### 3. Enable Interactivity

**Features → Interactivity & Shortcuts** → toggle on. No URL needed (Socket Mode).

### 4. Subscribe to bot events

**Features → Event Subscriptions** → toggle on → **Subscribe to bot events** → add all four:

| Event | Purpose |
|---|---|
| `app_mention` | Respond when @mentioned |
| `message.channels` | Receive replies in public channels (required for thread replies without @mention) |
| `message.groups` | Same for private channels |
| `message.im` | Direct messages |

> **`message.channels` and `message.groups` are the most commonly missed.** Without them, the bot only responds to @mentions — thread replies without a mention are silently ignored.

Save changes. Slack will ask you to reinstall — do it.

### 5. Set OAuth scopes

**Features → OAuth & Permissions → Scopes → Bot Token Scopes** — add:

`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `chat:write.public`, `files:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`

Reinstall the app to the workspace if prompted.

### 6. Copy your tokens

| Token | Where to find it |
|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-...`) | OAuth & Permissions → OAuth Tokens |
| `SLACK_APP_TOKEN` (`xapp-...`) | Basic Information → App-Level Tokens |
| `SLACK_SIGNING_SECRET` | Basic Information → Signing Secret |

---

## First-time install (systemd)

Prerequisites — verify before running:
- `/opt/claude-slack-bridge/.env` populated with all required vars (see `.env.example`); generate `APPROVAL_HMAC_SECRET` with `openssl rand -hex 32`.
- `/root/.claude/.credentials.json` present (Claude Code subscription auth) OR `ANTHROPIC_API_KEY` in `.env`.
- `npm install` has been run in `/opt/claude-slack-bridge`.

Then:

```bash
cp /opt/claude-slack-bridge/deploy/claude-slack-bridge.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-slack-bridge.service
```

Watch logs:

```bash
journalctl -u claude-slack-bridge -f
```

Health check:

```bash
systemctl status claude-slack-bridge --no-pager | head -10
journalctl -u claude-slack-bridge --since '1 min ago' | grep -E 'running|ERROR'
```

The bot is healthy if you see `⚡️ Claude Code Slack bot is running!` and no recent ERROR lines.

## Updating after code changes

```bash
cd /opt/claude-slack-bridge
git pull
npm install                              # only if package.json changed
systemctl restart claude-slack-bridge
journalctl -u claude-slack-bridge -f
```

## Rollback

If a deploy goes bad and you need to revert quickly:

```bash
cd /opt/claude-slack-bridge
git log --oneline -5                     # find the last-known-good commit
git checkout <good-commit-sha>           # detached HEAD — that's fine
systemctl restart claude-slack-bridge
journalctl -u claude-slack-bridge --since '30s ago' | grep -E 'running|ERROR'
```

If the bot still won't start, walk further back. To return to mainline once a fix lands:

```bash
git checkout main && git pull
systemctl restart claude-slack-bridge
```

## Stopping / disabling

```bash
systemctl stop claude-slack-bridge           # one-off stop
systemctl disable --now claude-slack-bridge  # stop + don't start at boot
```

## Using the bot

### Set a working directory

The bot requires a working directory before it will run commands. Set one per-channel or per-thread:

```
cwd /opt/my-project          # absolute path
cwd my-project               # relative to BASE_DIRECTORY (if set in .env)
```

Threads can override the channel default: mention the bot in a thread with `@bot cwd /other/path`.

### Talk to the bot

- **In a channel**: `@Claude Code Bot <your message>` — starts a thread.
- **In a thread where the bot has been active**: just type — no @mention needed (requires `message.channels` event subscription).
- **Direct message**: send a message directly to the bot (requires `ALLOW_DMS=true` is not currently enforced but DMs are off by default via `allowDms: false`).

### Approval buttons

Whenever Claude wants to run a mutating command (`Bash`, `Write`, `Edit`, etc.) a Slack card appears with three buttons:

| Button | Effect |
|---|---|
| ✅ Approve | Run this one command |
| ❌ Deny | Block this command |
| 🔄 Always approve this command | Auto-approve this specific command family for the rest of the thread (e.g. approving `roadie-list add ...` auto-approves all future `roadie-list add` calls, but not `roadie-list read` or other tools) |

Read-only tools (`Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `NotebookRead`, `TodoWrite`) and read-only MCP tools (GitHub reads, git reads, postgres SELECT) are always auto-approved and never show a card.

`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Task` always show a card even if you've used "Always approve" — the blast radius is too high for bulk opt-in.

### Bot commands

| Command | Effect |
|---|---|
| `cwd <path>` | Set working directory for channel or thread |
| `@bot cwd <path>` | Set working directory for a specific thread |
| `mcp` / `mcp info` | Show loaded MCP server config |
| `mcp reload` | Reload MCP config from `mcp-servers.json` without restart |

---

## Token rotation

Rotate when a token has been logged, leaked, or just on a periodic cadence (recommended every 90 days for `SLACK_BOT_TOKEN`, on each suspected compromise for `APPROVAL_HMAC_SECRET`).

### Slack tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, signing secret)

1. Go to <https://api.slack.com/apps> → your "Claude Code Bot" app.
2. Bot token: **OAuth & Permissions** → "Reinstall to Workspace" (regenerates the bot token) → copy the new `xoxb-...`.
3. App-level token: **Basic Information** → "App-Level Tokens" → revoke + regenerate → copy the new `xapp-...`.
4. Signing secret: **Basic Information** → "Signing Secret" → can be rotated by clicking "Show" then "Regenerate".
5. On TRC1, edit the env file and replace the values:

   ```bash
   sed -i 's|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=xoxb-paste-here|' /opt/claude-slack-bridge/.env
   sed -i 's|^SLACK_APP_TOKEN=.*|SLACK_APP_TOKEN=xapp-paste-here|' /opt/claude-slack-bridge/.env
   sed -i 's|^SLACK_SIGNING_SECRET=.*|SLACK_SIGNING_SECRET=paste-here|' /opt/claude-slack-bridge/.env
   chmod 600 /opt/claude-slack-bridge/.env
   ```

6. Restart the bot: `systemctl restart claude-slack-bridge`.

### `APPROVAL_HMAC_SECRET`

In-flight approvals are invalidated when this rotates — that's the desired behavior on a rotation event.

```bash
# Generate + replace in one shot. Value never echoed to terminal history.
# The semicolon matters — without it, `NEWHMAC=...` becomes a one-shot env var
# scoped to the sed invocation only, AND the shell expands $NEWHMAC BEFORE
# setting it, so sed runs with empty $NEWHMAC and wipes the secret.
NEWHMAC=$(openssl rand -hex 32); sed -i "s|^APPROVAL_HMAC_SECRET=.*|APPROVAL_HMAC_SECRET=$NEWHMAC|" /opt/claude-slack-bridge/.env
unset NEWHMAC
chmod 600 /opt/claude-slack-bridge/.env
systemctl restart claude-slack-bridge
```

### After any rotation: scrub leak surfaces

```bash
: > /tmp/slack-bot.log                   # if any pre-systemd logs remain
journalctl --vacuum-time=1s              # nuke older journald entries
```

## Debugging stuck approvals

Symptom: clicked a Slack button but the bot says "Permission request timed out" 5 minutes later.

```bash
# Did the click reach the bot?
journalctl -u claude-slack-bridge --since '10 min ago' | grep -E 'approval click|Tool approval|Approval received|Approval timed out'

# Anything in the IPC dir?
ls -la /var/lib/claude-slack-bridge/approvals/

# Any forged-decision rejections?
journalctl -u claude-slack-bridge --since '10 min ago' | grep -E 'Forged|signature invalid|Hard-denied'
```

Common causes:
- **No "approval click" log line** → Slack didn't deliver the action. Check Slack app → Interactivity & Shortcuts is on; check Socket Mode is enabled and `xapp-` token is valid.
- **Click logged, no "Approval received via file IPC"** → IPC write failed. Check `/var/lib/claude-slack-bridge/` permissions (should be 0700 root) and disk space.
- **"Forged approval rejected"** → `APPROVAL_HMAC_SECRET` doesn't match between the bot process and the MCP subprocess. Restart the bot.
- **"Hard-denied dangerous command"** → bot's deny pattern fired (intentional). The reason is in the log line. SSH in to do this manually if it was intentional.

## Sanity checks

```bash
# Bot can spawn the permission-prompt MCP?
ls -la /opt/claude-slack-bridge/node_modules/.bin/tsx  # should exist
ls -la /opt/claude-slack-bridge/src/permission-mcp-server.ts  # should exist

# State dir is correctly owned?
ls -ld /var/lib/claude-slack-bridge        # should be drwx------ root root
ls -ld /var/lib/claude-slack-bridge/approvals  # same

# .env is locked down?
ls -la /opt/claude-slack-bridge/.env       # should be -rw------- root root

# Slack app reachable with current bot token?
set -a; source /opt/claude-slack-bridge/.env; set +a
curl -sS -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test | python3 -m json.tool
```

# Deployment

## systemd install (first time)

```bash
# As root on TRC1:
cp /opt/claude-slack-bridge/deploy/claude-slack-bridge.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-slack-bridge.service

# Watch logs:
journalctl -u claude-slack-bridge -f
```

## Updating after code changes

```bash
cd /opt/claude-slack-bridge
git pull
npm install                              # only if package.json changed
systemctl restart claude-slack-bridge
journalctl -u claude-slack-bridge -f
```

## Stopping

```bash
systemctl stop claude-slack-bridge           # one-off stop
systemctl disable --now claude-slack-bridge  # stop + never boot-start again
```

## Prerequisites before first `systemctl enable`

- `/opt/claude-slack-bridge/.env` populated with all required vars (see `.env.example`)
- `/root/.claude/.credentials.json` present and valid (Claude Code subscription auth)
- `npm install` has been run in `/opt/claude-slack-bridge`

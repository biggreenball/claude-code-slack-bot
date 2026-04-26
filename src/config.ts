import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  defaultWorkingDirectory: process.env.DEFAULT_WORKING_DIRECTORY || '',
  // Use BOT_DEBUG (not DEBUG) — Anthropic's Claude Code SDK keys its own
  // verbose mode on `DEBUG`, and that mode dumps spawn args (including the
  // env block with our SLACK_BOT_TOKEN / APPROVAL_HMAC_SECRET) to stderr.
  // Keeping `DEBUG` unset prevents that secret leak.
  debug: process.env.BOT_DEBUG === 'true' || process.env.NODE_ENV === 'development',
  access: {
    allowedSlackUserIds: new Set(
      (process.env.ALLOWED_SLACK_USER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    allowedSlackChannelIds: new Set(
      (process.env.ALLOWED_SLACK_CHANNEL_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    allowDms: process.env.ALLOW_DMS === 'true',
  },
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'ALLOWED_SLACK_USER_IDS',
    'APPROVAL_HMAC_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
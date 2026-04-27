import { App, LogLevel } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';

const logger = new Logger('Main');

// Verify the bits the permission-prompt MCP subprocess will need are actually
// reachable from process.cwd(). Without this, a missing tsx binary or a
// renamed permission-mcp-server.ts surfaces as a silent 5-min approval
// timeout in Slack — far harder to diagnose than a refused-to-start at boot.
function preflightMcpSpawnPaths(): void {
  const cwd = process.cwd();
  const mcpSource = path.join(cwd, 'src', 'permission-mcp-server.ts');
  const tsxBin = path.join(cwd, 'node_modules', '.bin', 'tsx');
  const missing: string[] = [];
  if (!fs.existsSync(mcpSource)) missing.push(`MCP source: ${mcpSource}`);
  if (!fs.existsSync(tsxBin)) missing.push(`tsx binary: ${tsxBin}`);
  if (missing.length > 0) {
    throw new Error(
      `Permission-prompt MCP cannot be spawned — missing required paths:\n  - ${missing.join('\n  - ')}\nStart the bot from /opt/claude-slack-bridge (or run \`npm install\` if tsx is missing).`,
    );
  }
  // Validate APPROVAL_HMAC_SECRET length here at startup. validateConfig only
  // checks presence; the MCP subprocess's getHmacSecret() throws at sign-time
  // (i.e., when the user's first gated tool call happens), which surfaces as
  // a confusing 5-min approval timeout. Catching it at boot is loud + correct.
  const secret = process.env.APPROVAL_HMAC_SECRET || '';
  if (secret.length < 32) {
    throw new Error(
      `APPROVAL_HMAC_SECRET must be >= 32 chars (current length: ${secret.length}). Generate with \`openssl rand -hex 32\` and replace the value in /opt/claude-slack-bridge/.env.`,
    );
  }
}

async function start() {
  try {
    // Validate configuration
    validateConfig();
    preflightMcpSpawnPaths();

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
      logLevel: config.debug ? LogLevel.DEBUG : LogLevel.INFO,
    });

    // Global middleware: log every incoming payload so we can diagnose missing
    // action routing (e.g., Slack delivering vs. action_id matching).
    app.use(async ({ body, next }: any) => {
      try {
        const payloadType = body?.type || body?.event?.type || 'unknown';
        const actionIds = Array.isArray(body?.actions)
          ? body.actions.map((a: any) => a?.action_id)
          : undefined;
        logger.info('incoming Slack payload', { payloadType, actionIds });
      } catch {
        /* no-op */
      }
      await next();
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();
    
    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();
    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();
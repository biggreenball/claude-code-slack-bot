import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { loadAllSessions, saveSession, deleteSession } from './session-store';

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession>;
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    // Restore sessions from disk so a bot restart doesn't drop the user's
    // in-flight Claude conversation. The SDK's `--resume <session_id>` then
    // picks up server-side context (assuming the session is still alive on
    // Anthropic's side; if not, the SDK errors and the next message starts
    // fresh, which is the prior behavior).
    this.sessions = loadAllSessions();
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    const key = this.getSessionKey(userId, channelId, threadTs);
    this.sessions.set(key, session);
    saveSession(key, session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: slackContext ? 'default' : 'bypassPermissions',
    };

    // Add permission prompt tool if we have Slack context
    if (slackContext) {
      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
      this.logger.debug('Added permission prompt tool for Slack integration', slackContext);
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    
    // Add permission prompt server if we have Slack context
    if (slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', `${process.cwd()}/src/permission-mcp-server.ts`],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext),
            // Pass the HMAC secret only to the permission-prompt MCP, not to
            // any other subprocess (Claude tool execution doesn't get it).
            APPROVAL_HMAC_SECRET: process.env.APPROVAL_HMAC_SECRET,
          }
        }
      };
      
      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default, plus permission prompt tool
      const allowedTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        allowedTools.push('mcp__permission-prompt');
        // Auto-approve read-only built-in tools so Slack isn't spammed with
        // a button prompt every time Claude reads a file or searches. Anything
        // that mutates state (Bash, Edit, Write, NotebookEdit, Task) still
        // routes through the permission-prompt MCP → ✅/❌ buttons.
        allowedTools.push(
          'Read',
          'Glob',
          'Grep',
          'LS',
          'WebSearch',
          'WebFetch',
          'NotebookRead',
          'TodoWrite',
        );

        // Add common read-only MCP tools that don't require approval
        // GitHub read operations
        allowedTools.push(
          'mcp__github__search_repositories',
          'mcp__github__get_repository',
          'mcp__github__list_issues',
          'mcp__github__get_issue',
          'mcp__github__list_pull_requests',
          'mcp__github__get_pull_request',
          'mcp__github__get_file_contents',
          'mcp__github__list_repository_contents',
        );

        // Git read operations
        allowedTools.push(
          'mcp__git__log',
          'mcp__git__show',
          'mcp__git__diff',
          'mcp__git__status',
          'mcp__git__branch',
          'mcp__git__ls_files',
          'mcp__git__blame',
        );

        // Filesystem read operations
        allowedTools.push(
          'mcp__filesystem__read_file',
          'mcp__filesystem__list_directory',
          'mcp__filesystem__search_files',
          'mcp__filesystem__get_file_info',
        );

        // Database read operations (SELECT queries only)
        allowedTools.push(
          'mcp__postgres__query',
          'mcp__postgres__list_tables',
          'mcp__postgres__describe_table',
          'mcp__postgres__list_schemas',
        );

        // Web search operations
        allowedTools.push(
          'mcp__web-search__search',
        );
      }
      if (allowedTools.length > 0) {
        options.allowedTools = allowedTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools,
        hasSlackContext: !!slackContext,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    options.abortController = abortController || new AbortController();

    this.logger.debug('Claude query options', options);

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            session.lastActivity = new Date();
            // Persist the freshly-assigned session_id so a restart can resume.
            saveSession(
              this.getSessionKey(session.userId, session.channelId, session.threadTs),
              session,
            );
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        deleteSession(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}
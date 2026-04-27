import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import * as fs from 'fs';
import { writeApprovalDecision, listOrphanRequests } from './permission-mcp-server';
import { config } from './config';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private threadAutoApprovals = new Map<string, Set<string>>(); // threadKey -> userIds
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.logger.info('Access allowlist configured', {
      userCount: config.access.allowedSlackUserIds.size,
      channelCount: config.access.allowedSlackChannelIds.size,
      allowDms: config.access.allowDms,
    });
  }

  private isUserAllowed(userId: string | undefined): boolean {
    if (!userId) return false;
    return config.access.allowedSlackUserIds.has(userId);
  }

  private isChannelAllowed(channelId: string | undefined): boolean {
    if (!channelId) return false;
    // DMs have channel IDs starting with 'D'
    if (channelId.startsWith('D')) return config.access.allowDms;
    return config.access.allowedSlackChannelIds.has(channelId);
  }

  private isAllowed(userId: string | undefined, channelId?: string): boolean {
    if (!this.isUserAllowed(userId)) return false;
    if (channelId !== undefined && !this.isChannelAllowed(channelId)) return false;
    return true;
  }

  // Handles both approve_tool and deny_tool button clicks. Single write path
  // to /var/lib/.../approvals (no in-process resolveApproval shim — that
  // never worked across process boundaries, see PR-B notes). Errors during
  // the write are surfaced ephemerally so a disk-full / dir-deleted condition
  // doesn't silently wedge the user's tool call.
  private async handleDecisionClick(
    body: any,
    respond: (msg: any) => Promise<unknown>,
    behavior: 'allow' | 'deny',
  ): Promise<void> {
    const userId = body?.user?.id;
    const channelId = body?.channel?.id;
    if (!this.isAllowed(userId, channelId)) {
      this.logger.warn('Rejected click', { behavior, user: userId, channel: channelId });
      await respond({ response_type: 'ephemeral', text: 'Not authorized.' });
      return;
    }
    const approvalId = body?.actions?.[0]?.value;
    if (typeof approvalId !== 'string' || !approvalId) {
      this.logger.warn('Click missing approvalId', { behavior, user: userId });
      await respond({ response_type: 'ephemeral', text: 'Click was malformed (no approval id).' });
      return;
    }

    this.logger.info('Tool approval click', { behavior, approvalId });

    try {
      writeApprovalDecision(approvalId, {
        behavior,
        message: behavior === 'allow' ? 'Approved by user' : 'Denied by user',
      });
    } catch (err: any) {
      this.logger.error('Failed to persist decision', err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ Couldn't save your decision: ${err?.message || 'unknown error'}. The tool will time out after 5 min; try again or check the bot.`,
      });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      text: behavior === 'allow' ? '✅ Tool execution approved' : '❌ Tool execution denied',
    });
  }

  private async handleThreadAutoApproval(
    body: any,
    respond: (msg: any) => Promise<unknown>,
  ): Promise<void> {
    const userId = body?.user?.id;
    const channelId = body?.channel?.id;
    const threadTs = body?.message?.thread_ts;

    if (!this.isAllowed(userId, channelId)) {
      this.logger.warn('Rejected thread auto-approval click', { user: userId, channel: channelId });
      await respond({ response_type: 'ephemeral', text: 'Not authorized.' });
      return;
    }

    const approvalId = body?.actions?.[0]?.value;
    if (typeof approvalId !== 'string' || !approvalId) {
      this.logger.warn('Thread auto-approval click missing approvalId', { user: userId });
      await respond({ response_type: 'ephemeral', text: 'Click was malformed (no approval id).' });
      return;
    }

    // Enable thread auto-approval for this user
    this.setThreadAutoApproval(channelId, threadTs, userId);

    // Also approve the current request
    try {
      writeApprovalDecision(approvalId, {
        behavior: 'allow',
        message: 'Approved with thread auto-approval enabled',
      });
    } catch (err: any) {
      this.logger.error('Failed to persist auto-approval decision', err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ Couldn't save your decision: ${err?.message || 'unknown error'}. The tool will time out after 5 min; try again or check the bot.`,
      });
      return;
    }

    const context = threadTs ? 'this thread' : 'this channel';
    await respond({
      response_type: 'ephemeral',
      text: `🔄 Thread auto-approval enabled for ${context}. Future tool requests will be approved automatically.`,
    });
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;
    
    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);
      
      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    const isColdStart = !session;
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    // Cold-start backfill: if this is a fresh session BUT there's already a
    // thread with prior messages, pull the thread history via Slack API and
    // prepend it as context. Otherwise the bot has no idea what was said
    // before — particularly painful after restarts (Claude session_id may
    // be lost) and when a user @-mentions the bot in an existing thread.
    let backfillContext = '';
    if (isColdStart && thread_ts) {
      backfillContext = await this.fetchThreadBackfill(channel, thread_ts, ts);
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      let finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      if (backfillContext) {
        finalPrompt =
          `[Previous conversation in this Slack thread, for context — do not respond to these older messages directly]\n${backfillContext}\n[End previous conversation]\n\n[New message from <@${user}>]\n${finalPrompt}`;
      }

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, '🤔');
      
      // Create Slack context for permission prompts. Fall back to ts so that
      // top-level @-mentions (where thread_ts is undefined) still get their
      // approval cards posted into the thread the bot replies in, not at root.
      const slackContext = {
        channel,
        threadTs: thread_ts || ts,
        user,
        threadAutoApproved: this.isThreadAutoApproved(channel, thread_ts, user)
      };
      
      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) => 
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              
              // Send each new piece of content as a separate message
              await this.sendFormattedMessage(say, content, thread_ts || ts, false);
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });
          
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              await this.sendFormattedMessage(say, finalResult, thread_ts || ts, true);
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, '❌');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  // Tools that route through the permission-prompt MCP (and therefore already
  // get a Slack approval card showing what they're about to do). Suppress the
  // redundant post-approval diff message so the approval card stays as the
  // last visible item in the thread before the user clicks.
  private static readonly GATED_TOOLS = new Set([
    'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Task',
  ]);

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        // Gated tools — approval card already covers it, skip.
        if (SlackHandler.GATED_TOOLS.has(toolName)) {
          continue;
        }

        switch (toolName) {
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }

    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = '🔄'; // Tasks in progress
    } else {
      emoji = '📋'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  // Pull the thread's message history via conversations.replies and format it
  // as plaintext context to prepend to a fresh-session prompt. Best-effort:
  // if Slack errors out, we just return '' and Claude starts cold.
  private async fetchThreadBackfill(
    channel: string,
    threadTs: string,
    currentTs: string,
  ): Promise<string> {
    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 50,
      });
      const msgs = result.messages || [];
      const lines: string[] = [];
      for (const m of msgs) {
        // Skip the message that triggered THIS handleMessage (we'll add it
        // separately as the "new message").
        if (m.ts === currentTs) continue;
        // Skip our own approval cards / status messages — they're UI noise
        // and re-feeding them back to Claude doesn't help context.
        if (this.looksLikeBotUiMessage(m)) continue;
        const text = (m as any).text || '';
        if (!text.trim()) continue;
        const author = (m as any).bot_id ? 'bot' : (`<@${(m as any).user || 'unknown'}>`);
        lines.push(`${author}: ${text}`);
      }
      const joined = lines.join('\n');
      if (joined) {
        this.logger.info('Backfilled thread history into prompt', {
          channel, threadTs, lineCount: lines.length, charCount: joined.length,
        });
      }
      return joined;
    } catch (err: any) {
      this.logger.warn('Thread backfill failed', { channel, threadTs, error: err?.message });
      return '';
    }
  }

  private looksLikeBotUiMessage(m: any): boolean {
    if (!m.bot_id) return false;
    const text = typeof m.text === 'string' ? m.text : '';
    if (text.startsWith('Permission request for ')) return true;     // approval cards
    if (text.startsWith('🤔 ') || text.includes('*Thinking...*')) return true;  // status
    if (text.startsWith('⏱️ ') && text.includes('Expired')) return true;       // orphan-sweep
    if (text.startsWith('✅ *Task completed*')) return true;                    // status
    return false;
  }

  private getThreadKey(channelId: string, threadTs?: string): string {
    return threadTs ? `${channelId}:${threadTs}` : channelId;
  }

  private isThreadAutoApproved(channelId: string, threadTs: string | undefined, userId: string): boolean {
    const threadKey = this.getThreadKey(channelId, threadTs);
    const approvedUsers = this.threadAutoApprovals.get(threadKey);
    return approvedUsers?.has(userId) || false;
  }

  private setThreadAutoApproval(channelId: string, threadTs: string | undefined, userId: string): void {
    const threadKey = this.getThreadKey(channelId, threadTs);
    if (!this.threadAutoApprovals.has(threadKey)) {
      this.threadAutoApprovals.set(threadKey, new Set());
    }
    this.threadAutoApprovals.get(threadKey)!.add(userId);
    this.logger.info('Thread auto-approval enabled', { threadKey, userId });
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string | any {
    // Try to detect if this is a structured response that would benefit from rich blocks
    if (this.shouldUseRichBlocks(text)) {
      return this.createRichBlocks(text);
    }

    // Fallback: Convert GitHub-flavored markdown to Slack mrkdwn format
    let formatted = text
      // Headers: Convert ### Header to *Header* (bold)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // Code blocks: Preserve as-is (Slack supports these)
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      // Inline code: Preserve as-is
      .replace(/`([^`]+)`/g, '`$1`')
      // Bold: Convert **text** to *text*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Italic: Convert __text__ to _text_
      .replace(/__([^_]+)__/g, '_$1_')
      // Strikethrough: Convert ~~text~~ to ~text~
      .replace(/~~([^~]+)~~/g, '~$1~')
      // Lists: Convert GitHub-style - to Slack bullets
      .replace(/^[\s]*-\s+(.+)$/gm, '• $1')
      // Lists: Convert numbered lists to bullets (Slack doesn't support numbered)
      .replace(/^[\s]*\d+\.\s+(.+)$/gm, '• $1')
      // Blockquotes: Preserve as-is (Slack supports > quotes)
      .replace(/^>\s+(.+)$/gm, '> $1')
      // Links: Convert [text](url) to <url|text> format for Slack
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
      // Clean up multiple consecutive newlines (max 2)
      .replace(/\n{3,}/g, '\n\n');

    return formatted;
  }

  private shouldUseRichBlocks(text: string): boolean {
    // Use rich blocks for structured content that benefits from enhanced formatting
    return /^(#{1,6}\s|```|\*\*|##\s|###\s|•|\d+\.|>)/m.test(text) ||
           text.includes('✅') || text.includes('❌') || text.includes('🔄') ||
           text.split('\n').length > 3;
  }

  private createRichBlocks(text: string): any {
    const blocks: any[] = [];
    const lines = text.split('\n');
    let currentSection: any = null;
    let currentList: any = null;
    let inCodeBlock = false;
    let codeContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Handle code blocks
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End code block
          blocks.push({
            type: 'rich_text',
            elements: [{
              type: 'rich_text_preformatted',
              elements: [{
                type: 'text',
                text: codeContent.trim()
              }]
            }]
          });
          codeContent = '';
          inCodeBlock = false;
        } else {
          // Start code block
          this.finalizeCurrent(blocks, currentSection, currentList);
          currentSection = null;
          currentList = null;
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += line + '\n';
        continue;
      }

      // Handle headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        this.finalizeCurrent(blocks, currentSection, currentList);
        blocks.push({
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{
              type: 'text',
              text: headerMatch[2],
              style: { bold: true }
            }]
          }]
        });
        currentSection = null;
        currentList = null;
        continue;
      }

      // Handle lists
      const listMatch = line.match(/^[\s]*[-•]\s+(.+)$/) || line.match(/^[\s]*\d+\.\s+(.+)$/);
      if (listMatch) {
        if (!currentList) {
          this.finalizeCurrent(blocks, currentSection, currentList);
          currentSection = null;
          currentList = {
            type: 'rich_text',
            elements: [{
              type: 'rich_text_list',
              style: 'bullet',
              elements: []
            }]
          };
        }

        currentList.elements[0].elements.push({
          type: 'rich_text_section',
          elements: this.parseInlineFormatting(listMatch[1])
        });
        continue;
      }

      // Handle blockquotes
      const quoteMatch = line.match(/^>\s+(.+)$/);
      if (quoteMatch) {
        this.finalizeCurrent(blocks, currentSection, currentList);
        blocks.push({
          type: 'rich_text',
          elements: [{
            type: 'rich_text_quote',
            elements: [{
              type: 'text',
              text: quoteMatch[1]
            }]
          }]
        });
        currentSection = null;
        currentList = null;
        continue;
      }

      // Handle regular text
      if (line.trim()) {
        if (currentList) {
          this.finalizeCurrent(blocks, currentSection, currentList);
          currentList = null;
        }

        if (!currentSection) {
          currentSection = {
            type: 'rich_text',
            elements: [{
              type: 'rich_text_section',
              elements: []
            }]
          };
        }

        if (currentSection.elements[0].elements.length > 0) {
          currentSection.elements[0].elements.push({
            type: 'text',
            text: ' '
          });
        }

        currentSection.elements[0].elements.push(...this.parseInlineFormatting(line));
      } else if (currentSection) {
        // Empty line - finalize current section
        this.finalizeCurrent(blocks, currentSection, currentList);
        currentSection = null;
      }
    }

    // Finalize remaining content
    this.finalizeCurrent(blocks, currentSection, currentList);

    return { blocks };
  }

  private finalizeCurrent(blocks: any[], currentSection: any, currentList: any): void {
    if (currentList) {
      blocks.push(currentList);
    } else if (currentSection && currentSection.elements[0].elements.length > 0) {
      blocks.push(currentSection);
    }
  }

  private parseInlineFormatting(text: string): any[] {
    const elements: any[] = [];
    let remaining = text;

    // Parse inline formatting: **bold**, `code`, _italic_, ~~strike~~, [links](url)
    const patterns = [
      { regex: /\*\*([^*]+)\*\*/g, style: { bold: true } },
      { regex: /`([^`]+)`/g, style: { code: true } },
      { regex: /_([^_]+)_/g, style: { italic: true } },
      { regex: /~~([^~]+)~~/g, style: { strike: true } },
      { regex: /\[([^\]]+)\]\(([^)]+)\)/g, type: 'link' }
    ];

    let lastIndex = 0;
    const matches: Array<{index: number, length: number, text: string, style?: any, type?: string, url?: string}> = [];

    // Find all matches
    patterns.forEach(pattern => {
      const regex = new RegExp(pattern.regex.source, 'g');
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (pattern.type === 'link') {
          matches.push({
            index: match.index,
            length: match[0].length,
            text: match[1],
            type: 'link',
            url: match[2]
          });
        } else {
          matches.push({
            index: match.index,
            length: match[0].length,
            text: match[1],
            style: pattern.style
          });
        }
      }
    });

    // Sort matches by position
    matches.sort((a, b) => a.index - b.index);

    // Process matches
    matches.forEach(match => {
      // Add text before this match
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index);
        if (beforeText) {
          elements.push({ type: 'text', text: beforeText });
        }
      }

      // Add the formatted match
      if (match.type === 'link') {
        elements.push({
          type: 'link',
          url: match.url,
          text: match.text
        });
      } else {
        elements.push({
          type: 'text',
          text: match.text,
          style: match.style
        });
      }

      lastIndex = match.index + match.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      const remainingText = text.substring(lastIndex);
      if (remainingText) {
        elements.push({ type: 'text', text: remainingText });
      }
    }

    // If no formatting found, return simple text
    if (elements.length === 0) {
      elements.push({ type: 'text', text });
    }

    return elements;
  }

  private async sendFormattedMessage(say: any, content: string, threadTs: string, isFinal: boolean = false): Promise<void> {
    const formatted = this.formatMessage(content, isFinal);

    if (typeof formatted === 'string') {
      // Traditional text message
      await say({
        text: formatted,
        thread_ts: threadTs,
      });
    } else {
      // Rich blocks message
      await say({
        ...formatted,
        thread_ts: threadTs,
      });
    }
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        const user = (message as any).user;
        const channel = (message as any).channel;
        if (!this.isAllowed(user, channel)) {
          this.logger.warn('Rejected message', { user, channel });
          return;
        }
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      if (!this.isAllowed(event.user, event.channel)) {
        this.logger.warn('Rejected mention', { user: event.user, channel: event.channel });
        return;
      }
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle thread replies without mentions (if bot has active session)
    this.app.event('message', async ({ event, say }) => {
      // Skip bot messages, messages with subtypes (except file_share), and messages without users
      if ('bot_id' in event || !('user' in event)) return;

      const user = (event as any).user;
      const channel = (event as any).channel;
      const thread_ts = (event as any).thread_ts;

      if (!this.isAllowed(user, channel)) {
        return;
      }

      // Handle file uploads (original logic)
      if (event.subtype === 'file_share' && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
        return;
      }

      // Handle thread replies without mentions (only if no subtype and in a thread)
      if (!event.subtype && thread_ts) {
        // Check if bot has an active session for this thread
        const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts);
        const session = this.claudeHandler.getSession(user, channel, thread_ts);

        if (session) {
          this.logger.info('Handling thread reply without mention');
          await this.handleMessage(event as MessageEvent, say);
          return;
        }
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDecisionClick(body, respond, 'allow');
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      await this.handleDecisionClick(body, respond, 'deny');
    });

    // Handle thread auto-approval button clicks
    this.app.action('approve_thread_always', async ({ ack, body, respond }) => {
      await ack();
      await this.handleThreadAutoApproval(body, respond);
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes

    // Sweep abandoned approval cards from previous bot lifetimes. Fire-and-
    // forget so we don't block setup; catch logs the result.
    void this.sweepOrphanApprovalCards();
  }

  // If the bot crashed (or got SIGKILL'd) between posting an approval card and
  // updating it with the final decision, the card sits there with live ✅/❌
  // buttons forever. On startup we look for `.request.json` files older than
  // the MCP's 5-min timeout (plus a 2-min grace) and rewrite the corresponding
  // Slack message to "expired" so users aren't staring at a dead card.
  private async sweepOrphanApprovalCards(): Promise<void> {
    const STALE_MS = 7 * 60 * 1000;
    let orphans;
    try {
      orphans = listOrphanRequests(STALE_MS);
    } catch (err: any) {
      this.logger.warn('Orphan sweep: failed to list', { error: err?.message });
      return;
    }
    if (orphans.length === 0) {
      this.logger.debug('Orphan sweep: nothing to do');
      return;
    }
    this.logger.info('Orphan sweep: marking abandoned cards expired', { count: orphans.length });
    for (const o of orphans) {
      if (o.channel && o.ts) {
        try {
          await this.app.client.chat.update({
            channel: o.channel,
            ts: o.ts,
            text: 'Permission request expired',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `⏱️ *Permission Request — Expired*\n\nThe bot was offline when this card was awaiting your click. Ask Claude again if you still want \`${o.tool_name || 'this tool'}\` to run.`,
                },
              },
            ],
          });
          this.logger.info('Orphan sweep: card expired', { approvalId: o.approvalId });
        } catch (err: any) {
          // Card may have been deleted, channel archived, etc. — log and
          // proceed; we still want to remove the stale request file.
          this.logger.warn('Orphan sweep: failed to update card', {
            approvalId: o.approvalId, error: err?.message,
          });
        }
      }
      try { fs.unlinkSync(o.filePath); } catch { /* best-effort */ }
    }
  }
}
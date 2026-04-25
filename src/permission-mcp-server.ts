#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

// Shared file-based IPC channel between the main bot process (button clicks
// arrive there) and the permission-prompt MCP subprocess (which awaits the
// decision). Both halves agree on this directory; main bot writes a decision
// file, subprocess polls for it. /tmp is fine — in-flight approvals don't
// need to survive a bot restart.
export const APPROVALS_DIR = '/tmp/claude-slack-bridge-approvals';

const logger = new Logger('PermissionMCP');

interface PermissionRequest {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
}

interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

class PermissionMCPServer {
  private server: Server;
  private slack: WebClient;
  private pendingApprovals = new Map<string, {
    resolve: (response: PermissionResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    this.server = new Server(
      {
        name: "permission-prompt",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "permission_prompt",
            description: "Request user permission for tool execution via Slack button",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: {
                  type: "string",
                  description: "Name of the tool requesting permission",
                },
                input: {
                  type: "object",
                  description: "Input parameters for the tool",
                },
                channel: {
                  type: "string",
                  description: "Slack channel ID",
                },
                thread_ts: {
                  type: "string",
                  description: "Slack thread timestamp",
                },
                user: {
                  type: "string",
                  description: "User ID requesting permission",
                },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "permission_prompt") {
        return await this.handlePermissionPrompt(request.params.arguments as unknown as PermissionRequest);
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const { tool_name, input } = params;

    // Get Slack context from environment (passed by Claude handler)
    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    // Generate unique approval ID
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const requestBody = formatToolForCard(tool_name, input);

    // Create approval message with buttons
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔐 *Permission Request* — Claude wants to use \`${tool_name}\`\n\n${requestBody}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Approve"
            },
            style: "primary",
            action_id: "approve_tool",
            value: approvalId
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Deny"
            },
            style: "danger",
            action_id: "deny_tool",
            value: approvalId
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Requested by: <@${user}> | Tool: ${tool_name}`
          }
        ]
      }
    ];

    try {
      // Send approval request to Slack
      const result = await this.slack.chat.postMessage({
        channel: channel || user || 'general',
        thread_ts: thread_ts,
        blocks,
        text: `Permission request for ${tool_name}` // Fallback text
      });

      // Wait for user response
      const response = await this.waitForApproval(approvalId);

      // Claude Code's permission-prompt-tool contract requires `updatedInput`
      // on `allow` (it's the input that will actually be passed to the tool).
      // Pass through the original input verbatim — we don't modify it.
      if (response.behavior === 'allow' && response.updatedInput === undefined) {
        response.updatedInput = input;
      }
      if (response.behavior === 'deny' && !response.message) {
        response.message = 'Denied by user';
      }

      // Update the message to show the result
      if (result.ts) {
        await this.slack.chat.update({
          channel: result.channel!,
          ts: result.ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${response.behavior === 'allow' ? '✅ *Approved*' : '❌ *Denied*'} — \`${tool_name}\`\n\n${requestBody}`
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${response.behavior === 'allow' ? 'Approved' : 'Denied'} by user | Tool: ${tool_name}`
                }
              ]
            }
          ],
          text: `Permission ${response.behavior === 'allow' ? 'approved' : 'denied'} for ${tool_name}`
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    } catch (error) {
      logger.error('Error handling permission prompt:', error);
      
      // Default to deny if there's an error
      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    }
  }

  private async waitForApproval(approvalId: string): Promise<PermissionResponse> {
    fs.mkdirSync(APPROVALS_DIR, { recursive: true });
    const filePath = path.join(APPROVALS_DIR, `${approvalId}.json`);

    const TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_MS = 300;
    const startedAt = Date.now();

    while (Date.now() - startedAt < TIMEOUT_MS) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const decision = JSON.parse(content) as PermissionResponse;
        try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
        logger.info('Approval received via file IPC', { approvalId, behavior: decision.behavior });
        return decision;
      } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
          logger.warn('Error reading approval file', { approvalId, error: err.message });
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    logger.warn('Approval timed out', { approvalId });
    return { behavior: 'deny', message: 'Permission request timed out' };
  }

  // Kept for backward compatibility / same-process callers; the cross-process
  // path uses writeApprovalDecision() below instead.
  public resolveApproval(approvalId: string, approved: boolean, updatedInput?: any) {
    writeApprovalDecision(approvalId, {
      behavior: approved ? 'allow' : 'deny',
      updatedInput: updatedInput || undefined,
      message: approved ? 'Approved by user' : 'Denied by user',
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Permission MCP server started');
  }
}

// Cross-process IPC: write the approval decision to a file the MCP subprocess
// polls. Atomic-ish via write-then-rename so the subprocess never reads a
// partially written file. Called from the main bot process on button click.
export function writeApprovalDecision(
  approvalId: string,
  decision: { behavior: 'allow' | 'deny'; updatedInput?: any; message?: string },
): void {
  fs.mkdirSync(APPROVALS_DIR, { recursive: true });
  const finalPath = path.join(APPROVALS_DIR, `${approvalId}.json`);
  const tmpPath = finalPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(decision));
  fs.renameSync(tmpPath, finalPath);
}

// Pretty-print a tool invocation for the Slack approval card. Mirrors
// formatToolUse in slack-handler.ts but without the post-approval prefix.
function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.substring(0, n) + '\n…[truncated]';
}

function formatToolForCard(toolName: string, input: any): string {
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit': {
      const filePath = input.file_path;
      const edits = toolName === 'MultiEdit'
        ? (input.edits || [])
        : [{ old_string: input.old_string, new_string: input.new_string }];
      let body = `📝 *${filePath}*\n`;
      for (const edit of edits) {
        const oldLines = truncate(edit.old_string, 600).split('\n');
        const newLines = truncate(edit.new_string, 600).split('\n');
        body += '```diff\n';
        for (const line of oldLines) body += `- ${line}\n`;
        for (const line of newLines) body += `+ ${line}\n`;
        body += '```\n';
      }
      return body;
    }
    case 'Write': {
      const filePath = input.file_path;
      const preview = truncate(input.content, 800);
      return `📄 *Creating* \`${filePath}\`\n\`\`\`\n${preview}\n\`\`\``;
    }
    case 'Bash': {
      const cmd = truncate(input.command, 1000);
      const desc = input.description ? `_${input.description}_\n` : '';
      return `💻 *Running command*\n${desc}\`\`\`bash\n${cmd}\n\`\`\``;
    }
    case 'NotebookEdit': {
      const p = input.notebook_path;
      return `📓 *Editing notebook* \`${p}\`\n\`\`\`\n${truncate(input.new_source, 500)}\n\`\`\``;
    }
    case 'Task': {
      const subagent = input.subagent_type || 'general-purpose';
      const desc = input.description || '';
      return `🤖 *Spawning ${subagent} subagent*\n_${desc}_\n\`\`\`\n${truncate(input.prompt, 500)}\n\`\`\``;
    }
    default:
      return `*Parameters:*\n\`\`\`json\n${truncate(JSON.stringify(input, null, 2), 1000)}\n\`\`\``;
  }
}

// Export singleton instance for use by Slack handler
export const permissionServer = new PermissionMCPServer();

// Run if this file is executed directly (not imported)
if (process.argv[1]?.includes('permission-mcp-server')) {
  permissionServer.run().catch((error) => {
    logger.error('Permission MCP server error:', error);
    process.exit(1);
  });
}
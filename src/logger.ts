import { config } from './config';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;
    
    if (data) {
      return `${prefix} ${message}\n${JSON.stringify(data, null, 2)}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: any) {
    if (config.debug) {
      // Route to stderr, not stdout. The permission-prompt MCP subprocess uses
      // stdout for JSON-RPC traffic with Claude Code; any stray stdout writes
      // (like log lines) corrupt the protocol and silently break approvals.
      console.error(this.formatMessage('DEBUG', message, data));
    }
  }

  info(message: string, data?: any) {
    // See debug() above — must go to stderr for MCP subprocess safety.
    console.error(this.formatMessage('INFO', message, data));
  }

  warn(message: string, data?: any) {
    console.warn(this.formatMessage('WARN', message, data));
  }

  error(message: string, error?: any) {
    const errorData = error instanceof Error ? {
      errorMessage: error.message,
      stack: error.stack,
      ...error
    } : error;
    console.error(this.formatMessage('ERROR', message, errorData));
  }
}
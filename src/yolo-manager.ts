import { Logger } from './logger';

export enum YoloLevel {
  SAFE = 0,        // Always prompt (current behavior)
  READ_ONLY = 1,   // Auto-approve read operations
  LOW_RISK = 2,    // Level 1 + safe bash commands
  MEDIUM_RISK = 3, // Level 2 + file operations in working directory
  FULL_YOLO = 4,   // Auto-approve almost everything except hard-deny patterns
}

export interface YoloConfig {
  globalLevel: YoloLevel;
  allowPerUser: boolean;
  allowPerChannel: boolean;
  allowPerThread: boolean;
}

export interface YoloContext {
  userId: string;
  channelId: string;
  threadTs?: string;
  toolName: string;
  input: any;
  workingDirectory?: string;
}

export class YoloManager {
  private logger = new Logger('YoloManager');
  private userYoloLevels = new Map<string, YoloLevel>(); // userId -> level
  private channelYoloLevels = new Map<string, YoloLevel>(); // channelId -> level
  private threadYoloLevels = new Map<string, YoloLevel>(); // threadKey -> level

  // Tools that are always safe to auto-approve at READ_ONLY level
  private static readonly READ_ONLY_TOOLS = new Set([
    'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'
  ]);

  // Bash commands that are safe at LOW_RISK level
  private static readonly SAFE_BASH_PATTERNS = [
    /^ls(\s|$)/i,
    /^pwd(\s|$)/i,
    /^whoami(\s|$)/i,
    /^date(\s|$)/i,
    /^echo(\s|$)/i,
    /^cat\s+[^|>&;]+(\s|$)/i, // cat without pipes/redirects
    /^head(\s|$)/i,
    /^tail(\s|$)/i,
    /^wc(\s|$)/i,
    /^grep(\s|$)/i,
    /^find(\s|$)/i,
    /^which(\s|$)/i,
    /^type(\s|$)/i,
    /^git\s+(status|log|show|diff|branch|remote)(\s|$)/i, // read-only git commands
  ];

  // Tools that require MEDIUM_RISK level
  private static readonly MEDIUM_RISK_TOOLS = new Set([
    'Edit', 'MultiEdit', 'Write', 'NotebookEdit'
  ]);

  // Tools that require FULL_YOLO level
  private static readonly HIGH_RISK_TOOLS = new Set([
    'Task' // Spawning subagents
  ]);

  constructor(private config: YoloConfig) {
    this.logger.info('YOLO Manager initialized', {
      globalLevel: config.globalLevel,
      allowPerUser: config.allowPerUser,
      allowPerChannel: config.allowPerChannel,
      allowPerThread: config.allowPerThread,
    });
  }

  /**
   * Get the effective YOLO level for a given context
   */
  getEffectiveYoloLevel(context: YoloContext): YoloLevel {
    const { userId, channelId, threadTs } = context;

    // Thread-specific level takes highest priority
    if (this.config.allowPerThread && threadTs) {
      const threadKey = this.getThreadKey(channelId, threadTs);
      const threadLevel = this.threadYoloLevels.get(threadKey);
      if (threadLevel !== undefined) {
        return threadLevel;
      }
    }

    // User-specific level takes second priority
    if (this.config.allowPerUser) {
      const userLevel = this.userYoloLevels.get(userId);
      if (userLevel !== undefined) {
        return userLevel;
      }
    }

    // Channel-specific level takes third priority
    if (this.config.allowPerChannel) {
      const channelLevel = this.channelYoloLevels.get(channelId);
      if (channelLevel !== undefined) {
        return channelLevel;
      }
    }

    // Fall back to global level
    return this.config.globalLevel;
  }

  /**
   * Check if a tool should be auto-approved based on YOLO level
   */
  shouldAutoApprove(context: YoloContext): boolean {
    const level = this.getEffectiveYoloLevel(context);
    const { toolName, input, workingDirectory } = context;

    this.logger.debug('Checking auto-approval', {
      toolName,
      level,
      userId: context.userId,
      channelId: context.channelId,
      threadTs: context.threadTs,
    });

    // Level 0: Never auto-approve
    if (level === YoloLevel.SAFE) {
      return false;
    }

    // Level 1: Read-only tools
    if (level >= YoloLevel.READ_ONLY && YoloManager.READ_ONLY_TOOLS.has(toolName)) {
      this.logger.info('Auto-approving read-only tool', { toolName, level });
      return true;
    }

    // Level 2: Safe bash commands
    if (level >= YoloLevel.LOW_RISK && toolName === 'Bash') {
      const command = input?.command;
      if (typeof command === 'string' && this.isSafeBashCommand(command)) {
        this.logger.info('Auto-approving safe bash command', { command, level });
        return true;
      }
    }

    // Level 3: File operations in working directory
    if (level >= YoloLevel.MEDIUM_RISK && YoloManager.MEDIUM_RISK_TOOLS.has(toolName)) {
      if (this.isFileOperationInWorkingDir(input, workingDirectory)) {
        this.logger.info('Auto-approving file operation in working directory', { toolName, level });
        return true;
      }
    }

    // Level 4: Almost everything (except what's handled by hard-deny patterns)
    if (level >= YoloLevel.FULL_YOLO) {
      // High-risk tools require explicit approval even at FULL_YOLO
      if (!YoloManager.HIGH_RISK_TOOLS.has(toolName)) {
        this.logger.info('Auto-approving with full YOLO', { toolName, level });
        return true;
      }
    }

    return false;
  }

  /**
   * Set YOLO level for a user
   */
  setUserYoloLevel(userId: string, level: YoloLevel): void {
    if (!this.config.allowPerUser) {
      throw new Error('Per-user YOLO levels are not enabled');
    }
    this.userYoloLevels.set(userId, level);
    this.logger.info('Set user YOLO level', { userId, level });
  }

  /**
   * Set YOLO level for a channel
   */
  setChannelYoloLevel(channelId: string, level: YoloLevel): void {
    if (!this.config.allowPerChannel) {
      throw new Error('Per-channel YOLO levels are not enabled');
    }
    this.channelYoloLevels.set(channelId, level);
    this.logger.info('Set channel YOLO level', { channelId, level });
  }

  /**
   * Set YOLO level for a thread
   */
  setThreadYoloLevel(channelId: string, threadTs: string, level: YoloLevel): void {
    if (!this.config.allowPerThread) {
      throw new Error('Per-thread YOLO levels are not enabled');
    }
    const threadKey = this.getThreadKey(channelId, threadTs);
    this.threadYoloLevels.set(threadKey, level);
    this.logger.info('Set thread YOLO level', { channelId, threadTs, level });
  }

  /**
   * Get YOLO level descriptions for UI
   */
  static getYoloLevelDescription(level: YoloLevel): string {
    switch (level) {
      case YoloLevel.SAFE:
        return '🔒 Safe (Always prompt)';
      case YoloLevel.READ_ONLY:
        return '👁️ Read-Only (Auto-approve reads)';
      case YoloLevel.LOW_RISK:
        return '🟡 Low-Risk (Reads + safe commands)';
      case YoloLevel.MEDIUM_RISK:
        return '🟠 Medium-Risk (+ file operations in working dir)';
      case YoloLevel.FULL_YOLO:
        return '🔴 Full YOLO (Auto-approve almost everything)';
      default:
        return 'Unknown level';
    }
  }

  /**
   * Format YOLO status for display
   */
  formatYoloStatus(context: YoloContext): string {
    const level = this.getEffectiveYoloLevel(context);
    const description = YoloManager.getYoloLevelDescription(level);

    let source = 'global';
    if (this.config.allowPerThread && context.threadTs) {
      const threadKey = this.getThreadKey(context.channelId, context.threadTs);
      if (this.threadYoloLevels.has(threadKey)) {
        source = 'thread';
      }
    }
    if (source === 'global' && this.config.allowPerUser && this.userYoloLevels.has(context.userId)) {
      source = 'user';
    }
    if (source === 'global' && this.config.allowPerChannel && this.channelYoloLevels.has(context.channelId)) {
      source = 'channel';
    }

    return `🎯 **YOLO Level**: ${description}\n*Source: ${source} setting*`;
  }

  private getThreadKey(channelId: string, threadTs: string): string {
    return `${channelId}:${threadTs}`;
  }

  private isSafeBashCommand(command: string): boolean {
    const trimmed = command.trim();
    return YoloManager.SAFE_BASH_PATTERNS.some(pattern => pattern.test(trimmed));
  }

  private isFileOperationInWorkingDir(input: any, workingDirectory?: string): boolean {
    if (!workingDirectory) {
      return false;
    }

    const filePath = input?.file_path || input?.notebook_path;
    if (typeof filePath !== 'string') {
      return false;
    }

    // Resolve relative paths and check if they're within the working directory
    const path = require('path');
    const resolvedPath = path.resolve(workingDirectory, filePath);
    const resolvedWorkingDir = path.resolve(workingDirectory);

    // Check if the resolved path starts with the working directory
    return resolvedPath.startsWith(resolvedWorkingDir);
  }

  /**
   * Clear YOLO settings for cleanup
   */
  clearUserYoloLevel(userId: string): void {
    this.userYoloLevels.delete(userId);
    this.logger.info('Cleared user YOLO level', { userId });
  }

  clearChannelYoloLevel(channelId: string): void {
    this.channelYoloLevels.delete(channelId);
    this.logger.info('Cleared channel YOLO level', { channelId });
  }

  clearThreadYoloLevel(channelId: string, threadTs: string): void {
    const threadKey = this.getThreadKey(channelId, threadTs);
    this.threadYoloLevels.delete(threadKey);
    this.logger.info('Cleared thread YOLO level', { channelId, threadTs });
  }
}
import * as fs from 'fs';
import * as path from 'path';
import { ConversationSession } from './types';
import { Logger } from './logger';

// Per-session JSON files under StateDirectory= so sessions survive bot
// restart. Without this, every restart drops in-memory state and Claude
// loses thread context — a real day-to-day pain since systemd restarts the
// bot on any crash, and we restart it ourselves during deploys.
//
// File-per-session is consistent with the approval IPC pattern: atomic via
// write-then-rename, no DB dependency, easy to inspect on disk.
const SESSIONS_DIR = '/var/lib/claude-slack-bridge/sessions';
const logger = new Logger('SessionStore');

// Slack IDs are uppercase alnum; threadTs has dots. Encode the composite key
// so it's safe to use as a filename and reversible if we ever need it.
function safeKey(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url');
}

export interface PersistedSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: string; // ISO8601 — Date doesn't survive JSON round-trip
  workingDirectory?: string;
}

function toPersisted(session: ConversationSession): PersistedSession {
  return {
    userId: session.userId,
    channelId: session.channelId,
    threadTs: session.threadTs,
    sessionId: session.sessionId,
    isActive: session.isActive,
    lastActivity: session.lastActivity.toISOString(),
    workingDirectory: session.workingDirectory,
  };
}

function fromPersisted(p: PersistedSession): ConversationSession {
  return {
    userId: p.userId,
    channelId: p.channelId,
    threadTs: p.threadTs,
    sessionId: p.sessionId,
    isActive: p.isActive,
    lastActivity: new Date(p.lastActivity),
    workingDirectory: p.workingDirectory,
  };
}

// Reconstruct the in-memory session key from a persisted session — must
// match ClaudeHandler.getSessionKey() exactly.
function keyFor(p: PersistedSession): string {
  return `${p.userId}-${p.channelId}-${p.threadTs || 'direct'}`;
}

export function loadAllSessions(): Map<string, ConversationSession> {
  const out = new Map<string, ConversationSession>();
  let entries: string[];
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return out;
    logger.warn('Failed to read sessions dir', { error: err?.message });
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(SESSIONS_DIR, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedSession;
      const session = fromPersisted(persisted);
      out.set(keyFor(persisted), session);
    } catch (err: any) {
      logger.warn('Skipping unreadable session file', { name, error: err?.message });
    }
  }
  if (out.size > 0) {
    logger.info('Loaded sessions from disk', { count: out.size });
  }
  return out;
}

export function saveSession(key: string, session: ConversationSession): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const finalPath = path.join(SESSIONS_DIR, `${safeKey(key)}.json`);
    const tmpPath = finalPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(toPersisted(session)), { mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
  } catch (err: any) {
    // Best-effort: persistence failure shouldn't take the bot down. Worst
    // case the session reverts to memory-only behavior for that key.
    logger.warn('Failed to save session', { key, error: err?.message });
  }
}

export function deleteSession(key: string): void {
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${safeKey(key)}.json`));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn('Failed to delete session file', { key, error: err?.message });
    }
  }
}

import { db } from '../config/database';

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

export interface LogEntry {
  groupId?: number | null;
  level: LogLevel;
  message: string;
  details?: Record<string, unknown>;
}

export class Logger {
  static async log(entry: LogEntry): Promise<void> {
    try {
      await db('sync_logs').insert({
        group_id: entry.groupId || null,
        level: entry.level,
        message: entry.message,
        details: entry.details ? JSON.stringify(entry.details) : null,
      });
    } catch (err) {
      console.error('[Logger] Failed to write log to DB:', err);
      console.log(`[${entry.level}] ${entry.message}`, entry.details || '');
    }
  }

  static info(message: string, groupId?: number, details?: Record<string, unknown>) {
    return this.log({ level: 'INFO', message, groupId, details });
  }

  static warning(message: string, groupId?: number, details?: Record<string, unknown>) {
    return this.log({ level: 'WARNING', message, groupId, details });
  }

  static error(message: string, groupId?: number, details?: Record<string, unknown>) {
    return this.log({ level: 'ERROR', message, groupId, details });
  }
}

import type Database from "better-sqlite3";
import type { Migration } from "../types.js";

export const durableRemindersMigration: Migration = {
  version: 3,
  name: "durable-reminders",
  up(database: Database.Database): void {
    database.exec(`
      CREATE TABLE reminder_settings_rebuilt (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        settlement_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        channel_id TEXT NOT NULL,
        first_reminder_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 3600),
        next_reminder_at INTEGER,
        last_reminder_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (id, session_id),
        UNIQUE (settlement_id, session_id),
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO reminder_settings_rebuilt
        (id, session_id, settlement_id, enabled, channel_id, first_reminder_at, interval_seconds,
         next_reminder_at, last_reminder_at, created_at, updated_at)
      SELECT id, session_id, settlement_id, enabled, channel_id, first_reminder_at,
        MAX(interval_seconds, 3600),
        CASE WHEN enabled = 1 AND last_reminder_at IS NOT NULL
          THEN MAX(COALESCE(next_reminder_at, last_reminder_at + MAX(interval_seconds, 3600)), last_reminder_at + MAX(interval_seconds, 3600))
          ELSE next_reminder_at END,
        last_reminder_at, created_at, updated_at
      FROM reminder_settings;
      DROP TABLE reminder_settings;
      ALTER TABLE reminder_settings_rebuilt RENAME TO reminder_settings;
      CREATE INDEX reminder_settings_due_idx ON reminder_settings(enabled, next_reminder_at) WHERE enabled = 1;

      CREATE TABLE reminder_logs_rebuilt (
        id TEXT PRIMARY KEY,
        setting_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'SENT', 'FAILED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        discord_message_id TEXT,
        last_error TEXT,
        delivery_kind TEXT NOT NULL DEFAULT 'AUTO' CHECK (delivery_kind IN ('AUTO', 'MANUAL')),
        channel_id TEXT NOT NULL,
        UNIQUE (setting_id, scheduled_at),
        FOREIGN KEY (setting_id, session_id) REFERENCES reminder_settings(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO reminder_logs_rebuilt
        (id, setting_id, session_id, settlement_id, scheduled_at, status, attempt_count, next_attempt_at,
         started_at, completed_at, discord_message_id, last_error, delivery_kind, channel_id)
      SELECT l.id, l.setting_id, l.session_id, l.settlement_id, l.scheduled_at, l.status, l.attempt_count,
        l.next_attempt_at, l.started_at, l.completed_at, l.discord_message_id, l.last_error, 'AUTO', s.channel_id
      FROM reminder_logs l JOIN reminder_settings s ON s.id = l.setting_id AND s.session_id = l.session_id;
      DROP TABLE reminder_logs;
      ALTER TABLE reminder_logs_rebuilt RENAME TO reminder_logs;
      CREATE INDEX reminder_logs_recovery_idx ON reminder_logs(status, next_attempt_at, started_at);
      CREATE INDEX reminder_logs_session_schedule_idx ON reminder_logs(session_id, scheduled_at DESC);
    `);
  },
};

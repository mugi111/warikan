import type Database from "better-sqlite3";
import type { Migration } from "../types.js";

export const initialSchemaMigration: Migration = {
  version: 1,
  name: "initial-schema",
  up(database: Database.Database): void {
    database.exec(`
      CREATE TABLE guilds (
        id TEXT PRIMARY KEY,
        discord_guild_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SETTLING', 'CLOSED')),
        creator_discord_user_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settling_at INTEGER,
        closed_at INTEGER,
        UNIQUE (id, guild_id),
        CHECK ((status = 'SETTLING') = (settling_at IS NOT NULL)),
        CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX sessions_guild_status_idx ON sessions(guild_id, status, updated_at DESC);

      CREATE TABLE session_members (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight < 1.0e308),
        fixed_adjustment INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        removed_at INTEGER,
        UNIQUE (session_id, discord_user_id),
        UNIQUE (id, session_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX session_members_active_idx ON session_members(session_id, removed_at, discord_user_id);

      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
        payer_member_id TEXT NOT NULL,
        created_by_discord_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (id, session_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
        FOREIGN KEY (payer_member_id, session_id) REFERENCES session_members(id, session_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX expenses_session_created_idx ON expenses(session_id, created_at, id);
      CREATE INDEX expenses_payer_idx ON expenses(session_id, payer_member_id);

      CREATE TABLE expense_members (
        expense_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (expense_id, member_id),
        FOREIGN KEY (expense_id, session_id) REFERENCES expenses(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (member_id, session_id) REFERENCES session_members(id, session_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX expense_members_session_member_idx ON expense_members(session_id, member_id);

      CREATE TABLE settlements (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('FINALIZED', 'INVALIDATED')),
        total_amount INTEGER NOT NULL CHECK (total_amount >= 0 AND total_amount <= 9007199254740991),
        created_by_discord_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finalized_at INTEGER NOT NULL,
        invalidated_at INTEGER,
        UNIQUE (session_id, version),
        UNIQUE (id, session_id),
        CHECK ((status = 'INVALIDATED') = (invalidated_at IS NOT NULL)),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE UNIQUE INDEX settlements_one_finalized_per_session_idx ON settlements(session_id) WHERE status = 'FINALIZED';
      CREATE INDEX settlements_session_version_idx ON settlements(session_id, version DESC);

      CREATE TABLE settlement_balances (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        share_amount INTEGER NOT NULL CHECK (share_amount >= 0 AND share_amount <= 9007199254740991),
        paid_amount INTEGER NOT NULL CHECK (paid_amount >= 0 AND paid_amount <= 9007199254740991),
        balance INTEGER NOT NULL CHECK (balance = paid_amount - share_amount),
        created_at INTEGER NOT NULL,
        UNIQUE (settlement_id, member_id),
        UNIQUE (settlement_id, session_id, member_id),
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (member_id, session_id) REFERENCES session_members(id, session_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX settlement_balances_session_member_idx ON settlement_balances(session_id, member_id);

      CREATE TABLE settlement_transfers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        from_member_id TEXT NOT NULL,
        to_member_id TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
        status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID', 'PAID')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        paid_at INTEGER,
        UNIQUE (settlement_id, from_member_id, to_member_id),
        CHECK (from_member_id <> to_member_id),
        CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (settlement_id, session_id, from_member_id) REFERENCES settlement_balances(settlement_id, session_id, member_id) ON DELETE RESTRICT,
        FOREIGN KEY (settlement_id, session_id, to_member_id) REFERENCES settlement_balances(settlement_id, session_id, member_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX settlement_transfers_due_idx ON settlement_transfers(settlement_id, status, from_member_id);
      CREATE INDEX settlement_transfers_session_status_idx ON settlement_transfers(session_id, status, updated_at);

      CREATE TABLE reminder_settings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        settlement_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        channel_id TEXT NOT NULL,
        first_reminder_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 60),
        next_reminder_at INTEGER,
        last_reminder_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (id, session_id),
        UNIQUE (settlement_id, session_id),
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX reminder_settings_due_idx ON reminder_settings(enabled, next_reminder_at) WHERE enabled = 1;

      CREATE TABLE reminder_logs (
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
        UNIQUE (setting_id, scheduled_at),
        FOREIGN KEY (setting_id, session_id) REFERENCES reminder_settings(id, session_id) ON DELETE RESTRICT,
        FOREIGN KEY (settlement_id, session_id) REFERENCES settlements(id, session_id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX reminder_logs_recovery_idx ON reminder_logs(status, next_attempt_at, started_at);
      CREATE INDEX reminder_logs_session_schedule_idx ON reminder_logs(session_id, scheduled_at DESC);
    `);
  }
};

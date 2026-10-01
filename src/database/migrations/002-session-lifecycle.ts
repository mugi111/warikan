import type Database from "better-sqlite3";
import type { Migration } from "../types.js";

export const sessionLifecycleMigration: Migration = {
  version: 2,
  name: "session-lifecycle",
  up(database: Database.Database): void {
    database.exec(`
      CREATE TABLE sessions_rebuilt (
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
        CHECK ((status IN ('SETTLING', 'CLOSED')) = (settling_at IS NOT NULL)),
        CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO sessions_rebuilt (id, guild_id, name, status, creator_discord_user_id, revision, created_at, updated_at, settling_at, closed_at)
      SELECT s.id, s.guild_id, s.name, s.status, s.creator_discord_user_id, s.revision, s.created_at, s.updated_at,
        CASE WHEN s.status IN ('SETTLING', 'CLOSED') THEN COALESCE(s.settling_at,
          (SELECT MAX(st.finalized_at) FROM settlements st WHERE st.session_id = s.id), s.closed_at, s.updated_at) ELSE NULL END,
        s.closed_at
      FROM sessions s;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuilt RENAME TO sessions;
      CREATE INDEX sessions_guild_status_idx ON sessions(guild_id, status, updated_at DESC);
    `);
  },
};

import type Database from "better-sqlite3";
import type { Migration } from "./types.js";
import { initialSchemaMigration } from "./migrations/001-initial-schema.js";
import { sessionLifecycleMigration } from "./migrations/002-session-lifecycle.js";
import { durableRemindersMigration } from "./migrations/003-durable-reminders.js";

const migrations: readonly Migration[] = [initialSchemaMigration, sessionLifecycleMigration, durableRemindersMigration];

export function runMigrations(database: Database.Database): void {
  const bootstrap = database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string }>;
    if (applied.length > migrations.length) throw new Error("Database contains unknown schema migrations");
    for (let index = 0; index < applied.length; index += 1) {
      const row = applied[index], migration = migrations[index];
      if (!row || !migration || row.version !== migration.version || row.name !== migration.name) {
        throw new Error(`Database migration history is invalid at version ${row?.version ?? "unknown"}`);
      }
    }
    if (applied.length === 0) {
      initialSchemaMigration.up(database);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(initialSchemaMigration.version, initialSchemaMigration.name, Date.now());
    }
  });
  bootstrap.immediate();

  for (const migration of migrations.slice(1)) {
    const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version);
    if (applied) continue;
    database.pragma("foreign_keys = OFF");
    try {
      const migrate = database.transaction(() => {
        migration.up(database);
        const violations = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
        if (violations.length) throw new Error(`Database migration produced ${violations.length} foreign key violation(s)`);
        database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      });
      migrate.immediate();
    } finally {
      database.pragma("foreign_keys = ON");
    }
  }
  const violations = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (violations.length) throw new Error(`Database migration produced ${violations.length} foreign key violation(s)`);
}

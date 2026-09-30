import type Database from "better-sqlite3";
import type { Migration } from "./types.js";
import { initialSchemaMigration } from "./migrations/001-initial-schema.js";

const migrations: readonly Migration[] = [initialSchemaMigration];

export function runMigrations(database: Database.Database): void {
  const applyMigrations = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);

    const applied = database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;

    if (applied.length > migrations.length) {
      throw new Error("Database contains unknown schema migrations");
    }

    for (let index = 0; index < applied.length; index += 1) {
      const row = applied[index];
      const migration = migrations[index];
      if (row === undefined || migration === undefined) {
        throw new Error("Database migration history is invalid");
      }
      if (row.version !== migration.version || row.name !== migration.name) {
        throw new Error(`Database migration history is invalid at version ${row.version}`);
      }
    }

    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
    );
    for (const migration of migrations.slice(applied.length)) {
      migration.up(database);
      insertMigration.run(migration.version, migration.name, Date.now());
    }

    const violations = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (violations.length > 0) {
      throw new Error(`Database migration produced ${violations.length} foreign key violation(s)`);
    }
  });

  applyMigrations.immediate();
}

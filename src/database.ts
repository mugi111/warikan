import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runMigrations } from "./database/migrations.js";

export interface OpenDatabaseOptions {
  path: string;
}

export async function openDatabase({ path }: OpenDatabaseOptions): Promise<Database.Database> {
  const databasePath = path === ":memory:" ? path : resolve(path);
  if (databasePath !== ":memory:") {
    await mkdir(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

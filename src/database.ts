import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

export async function openDatabase(): Promise<Database.Database> {
  const databasePath = resolve(config.databasePath);
  await mkdir(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  logger.info("SQLite database opened", { databasePath });

  return database;
}

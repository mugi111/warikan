import { dirname, resolve } from "node:path";
import { backupDatabase } from "./backup.js";
import { logger } from "../logger.js";

process.umask(0o077);

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

const databasePath = resolve(process.env.DATABASE_PATH?.trim() || "./data/warikan.sqlite");
const backupDirectory = resolve(process.env.BACKUP_DIRECTORY?.trim() || `${dirname(databasePath)}/backups`);
const retentionCount = positiveInteger("BACKUP_RETENTION_COUNT", 7);
const timeoutSeconds = positiveInteger("BACKUP_TIMEOUT_SECONDS", 240);
let interrupted = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interrupted = true;
    logger.warn("Backup cancellation requested", { signal });
  });
}

try {
  const result = await backupDatabase({ databasePath, backupDirectory, retentionCount, timeoutSeconds, shouldAbort: () => interrupted });
  logger.info("Database backup completed", { backupPath: result.backupPath, removedBackups: result.removedBackups });
} catch (error) {
  logger.error("Database backup failed", { errorType: error instanceof Error ? error.name : "unknown", error: error instanceof Error ? error.message : "Unknown error" });
  process.exitCode = 1;
}

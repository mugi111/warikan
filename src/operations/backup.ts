import { randomUUID } from "node:crypto";
import { readdir, lstat, mkdir, chmod, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface BackupOptions {
  databasePath: string;
  backupDirectory: string;
  retentionCount: number;
  timeoutSeconds: number;
  shouldAbort?: () => boolean;
}

export interface BackupResult {
  backupPath: string;
  removedBackups: number;
}

const generatedName = /^warikan-\d{8}T\d{6}Z-[0-9a-f-]{36}\.sqlite$/;

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer.`);
}

export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  positiveInteger(options.retentionCount, "retentionCount");
  positiveInteger(options.timeoutSeconds, "timeoutSeconds");
  if (options.timeoutSeconds > 240) throw new Error("timeoutSeconds must not exceed 240.");
  if (options.databasePath === ":memory:") throw new Error("A file-backed database is required for backups.");

  const databasePath = resolve(options.databasePath);
  const backupDirectory = resolve(options.backupDirectory);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const filename = `warikan-${stamp}-${randomUUID()}.sqlite`;
  const finalPath = join(backupDirectory, filename);
  const partialPath = `${finalPath}.partial`;
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  let verification: Database.Database | undefined;

  try {
    await database.backup(partialPath, {
      progress() {
        if (options.shouldAbort?.()) throw new Error("Backup cancelled.");
        if (Date.now() >= deadline) throw new Error("Backup timed out.");
        return 100;
      }
    });
    if (options.shouldAbort?.()) throw new Error("Backup cancelled.");
    if (Date.now() >= deadline) throw new Error("Backup timed out.");
    verification = new Database(partialPath, { readonly: true, fileMustExist: true });
    const check = verification.pragma("quick_check", { simple: true });
    verification.close();
    verification = undefined;
    if (check !== "ok") throw new Error("Backup integrity check failed.");
    await chmod(partialPath, 0o600);
    await rename(partialPath, finalPath);
  } catch (error) {
    verification?.close();
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    database.close();
  }

  try {
    const entries = await readdir(backupDirectory);
    const backups: { path: string; mtime: number }[] = [];
    for (const entry of entries) {
      if (!generatedName.test(entry)) continue;
      const path = join(backupDirectory, entry);
      try {
        const stat = await lstat(path);
        if (stat.isFile()) backups.push({ path, mtime: stat.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    backups.sort((a, b) => b.mtime - a.mtime || basename(b.path).localeCompare(basename(a.path)));
    let removedBackups = 0;
    for (const item of backups.slice(options.retentionCount)) {
      await rm(item.path, { force: true });
      removedBackups++;
    }
    return { backupPath: finalPath, removedBackups };
  } catch (error) {
    throw new Error("Backup was created but retention cleanup failed.", { cause: error });
  }
}

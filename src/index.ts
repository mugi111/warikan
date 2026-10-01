import { createApplication } from "./app.js";
import { config } from "./config.js";
import { openDatabase } from "./database.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const database = await openDatabase({ path: config.databasePath });
  logger.info("SQLite database opened", { databasePath: config.databasePath });
  const application = createApplication(database);
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutdown signal received", { signal });
    await application.stop();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await application.start();
  } catch (error) {
    await application.stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error("Application startup failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});

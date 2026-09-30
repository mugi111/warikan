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
    try {
      await application.stop();
    } catch (error) {
      logger.error("Application shutdown failed", { signal, errorType: error instanceof Error ? error.name : "unknown" });
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await application.start();
  } catch (error) {
    await application.stop().catch((stopError: unknown) => {
      logger.error("Application shutdown failed", { errorType: stopError instanceof Error ? stopError.name : "unknown" });
    });
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error("Application startup failed", {
    errorType: error instanceof Error ? error.name : "unknown"
  });
  process.exitCode = 1;
});

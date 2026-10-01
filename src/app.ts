import {
  Client,
  Events,
  GatewayIntentBits
} from "discord.js";
import type Database from "better-sqlite3";
import { ReminderService } from "./application/reminder-service.js";
import { SessionService } from "./application/session-service.js";
import { SettlementService } from "./application/settlement-service.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { DiscordReminderSender } from "./reminders/discord-sender.js";
import { ReminderWorker } from "./reminders/worker.js";
import { handleSessionInteraction } from "./discord/session-interactions.js";
import { handleSettlementInteraction } from "./discord/settlement-interactions.js";

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApplication(database: Database.Database): Application {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const reminderService = new ReminderService(database);
  const settlementService = new SettlementService(database);
  const reminderWorker = new ReminderWorker(reminderService, new DiscordReminderSender(client));
  const sessionService = new SessionService(database);
  const services = { sessions: sessionService, settlements: settlementService, reminders: reminderService, worker: reminderWorker };

  client.on(Events.ClientReady, (readyClient) => {
    logger.info("Discord client ready", { userId: readyClient.user.id });
    try {
      reminderWorker.start();
    } catch (error) {
      logger.error("Reminder worker failed to start", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      const handled = await handleSettlementInteraction(services, interaction);
      if (!handled) await handleSessionInteraction(sessionService, interaction);
    } catch (error) {
      logger.error("Interaction handler failed", { errorType: error instanceof Error ? error.name : "unknown" });
      if (interaction.isRepliable()) {
        const response = { content: "操作を完了できませんでした。時間をおいて再試行してください。", ephemeral: true, allowedMentions: { parse: [] } };
        if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => undefined);
        else await interaction.reply(response).catch(() => undefined);
      }
    }
  });

  client.on(Events.Error, (error) => {
    logger.error("Discord client error", { error: error.message });
  });

  return {
    async start() {
      await client.login(config.discordToken);
    },
    async stop() {
      await reminderWorker.stop();
      client.destroy();
      if (database.open) database.close();
      logger.info("Application stopped");
    }
  };
}

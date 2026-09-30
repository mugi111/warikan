import {
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction
} from "discord.js";
import type Database from "better-sqlite3";
import { ReminderService } from "./application/reminder-service.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { DiscordReminderSender } from "./reminders/discord-sender.js";
import { ReminderWorker } from "./reminders/worker.js";

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApplication(database: Database.Database): Application {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const reminderWorker = new ReminderWorker(new ReminderService(database), new DiscordReminderSender(client));

  client.on(Events.ClientReady, (readyClient) => {
    logger.info("Discord client ready", { userId: readyClient.user.id });
    try {
      reminderWorker.start();
    } catch (error) {
      logger.error("Reminder worker failed to start", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "warikan") return;
    await handleWarikan(interaction);
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

async function handleWarikan(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: "割り勘Botの準備ができました。セッション機能はこれから実装します。",
    ephemeral: true
  });
}

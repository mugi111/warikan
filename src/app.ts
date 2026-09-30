import {
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction
} from "discord.js";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createApplication(database: Database.Database): Application {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.ClientReady, (readyClient) => {
    logger.info("Discord client ready", { userId: readyClient.user.id });
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

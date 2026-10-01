import { REST, Routes } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { warikanCommand } from "./warikan.js";

const rest = new REST().setToken(config.discordToken);

try {
  const commands = [warikanCommand.toJSON()];
  const registered = await rest.put(
    Routes.applicationGuildCommands(config.discordApplicationId, config.discordGuildId),
    { body: commands }
  );
  logger.info("Guild commands registered", {
    count: Array.isArray(registered) ? registered.length : commands.length,
    guildId: config.discordGuildId
  });
} catch (error) {
  logger.error("Guild command registration failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}

import { REST, Routes } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { warikanCommand } from "./warikan.js";

const rest = new REST().setToken(config.discordToken);

try {
  const commands = [warikanCommand.toJSON()];
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordApplicationId, config.discordGuildId)
    : Routes.applicationCommands(config.discordApplicationId);
  const registered = await rest.put(route, { body: commands });
  logger.info("Discord commands registered", {
    count: Array.isArray(registered) ? registered.length : commands.length,
    scope: config.discordGuildId ? "guild" : "global",
    ...(config.discordGuildId ? { guildId: config.discordGuildId } : {})
  });
} catch (error) {
  logger.error("Discord command registration failed", {
    errorType: error instanceof Error ? error.name : "unknown"
  });
  process.exitCode = 1;
}

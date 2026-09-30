import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_APPLICATION_ID: z.string().trim().min(1),
  DISCORD_GUILD_ID: z.string().trim().min(1),
  DATABASE_PATH: z.string().trim().min(1).default("./data/warikan.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(`Invalid environment configuration: ${fields}`);
}

export const config = {
  discordToken: result.data.DISCORD_TOKEN,
  discordApplicationId: result.data.DISCORD_APPLICATION_ID,
  discordGuildId: result.data.DISCORD_GUILD_ID,
  databasePath: result.data.DATABASE_PATH,
  logLevel: result.data.LOG_LEVEL
} as const;

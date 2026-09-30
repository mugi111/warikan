import { InteractionContextType, SlashCommandBuilder } from "discord.js";

export const warikanCommand = new SlashCommandBuilder()
  .setName("warikan")
  .setDescription("割り勘セッションを操作します")
  .setContexts(InteractionContextType.Guild);

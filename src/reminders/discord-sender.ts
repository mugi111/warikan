import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import type { ReminderNotice } from "../application/reminder-service.js";
import { makeCustomId } from "../discord/custom-id.js";

export class ReminderDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ReminderDeliveryError";
  }
}

export interface ReminderSender {
  send(notice: ReminderNotice, revalidateSyncCallback: () => boolean): Promise<{ messageId: string } | null>;
}

export class DiscordReminderSender implements ReminderSender {
  constructor(private readonly client: Client) {}

  async send(notice: ReminderNotice, revalidateSyncCallback: () => boolean): Promise<{ messageId: string } | null> {
    if (!revalidateSyncCallback()) return null;
    let channel;
    try {
      channel = await this.client.channels.fetch(notice.channelId);
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      throw new ReminderDeliveryError("REMINDER_CHANNEL_FETCH_FAILED", status === 429 || status >= 500);
    }
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new ReminderDeliveryError("REMINDER_CHANNEL_UNAVAILABLE", false);
    }
    if (!("guildId" in channel) || channel.guildId !== notice.guildDiscordId) {
      throw new ReminderDeliveryError("REMINDER_CHANNEL_GUILD_MISMATCH", false);
    }
    const sessionName = notice.sessionName.replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, "\\$&");
    const transfers = notice.groups.flatMap((group) => group.transfers);
    if (transfers.length > 25) throw new ReminderDeliveryError("REMINDER_TOO_MANY_TRANSFERS", false);
    const sections = notice.groups.map((group) => {
      const payments = group.transfers.map((transfer) => `  <@${transfer.recipientDiscordUserId}>へ ${transfer.amount.toLocaleString("ja-JP")}円`).join("\n");
      return `<@${group.senderDiscordUserId}>\n${payments}`;
    });
    const content = `未払いの精算リマインド: ${sessionName} (settlement v${notice.settlementVersion})\n\n${sections.join("\n\n")}`;
    if (content.length > 2000) throw new ReminderDeliveryError("REMINDER_MESSAGE_TOO_LONG", false);
    if (!revalidateSyncCallback()) return null;
    try {
      const message = await channel.send({
        content,
        components: Array.from({ length: Math.ceil(transfers.length / 5) }, (_, row) =>
          new ActionRowBuilder<ButtonBuilder>().addComponents(...transfers.slice(row * 5, row * 5 + 5).map((transfer) =>
            new ButtonBuilder().setCustomId(makeCustomId("rpaid", notice.sessionId, 0, transfer.transferId.replaceAll("-", "")))
              .setLabel("支払済みにする").setStyle(ButtonStyle.Success),
          )),
        ),
        allowedMentions: { parse: [], users: notice.groups.map((group) => group.senderDiscordUserId), roles: [] },
      });
      return { messageId: message.id };
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      throw new ReminderDeliveryError(`DISCORD_SEND_FAILED_${status || "UNKNOWN"}`, status === 429 || status >= 500);
    }
  }
}

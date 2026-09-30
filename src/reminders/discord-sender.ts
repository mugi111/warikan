import type { Client } from "discord.js";
import type { ReminderNotice } from "../application/reminder-service.js";

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
    const channel = await this.client.channels.fetch(notice.channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new ReminderDeliveryError("REMINDER_CHANNEL_UNAVAILABLE", false);
    }
    const sections = notice.groups.map((group) => {
      const payments = group.transfers.map((transfer) => `  ${transfer.recipientDiscordUserId}: ${transfer.amount}`).join("\n");
      return `<@${group.senderDiscordUserId}>\n${payments}`;
    });
    const content = `未払いの精算リマインド: ${notice.sessionName} (settlement v${notice.settlementVersion})\n\n${sections.join("\n\n")}`;
    if (content.length > 2000) throw new ReminderDeliveryError("REMINDER_MESSAGE_TOO_LONG", false);
    if (!revalidateSyncCallback()) return null;
    try {
      const message = await channel.send({
        content,
        allowedMentions: { parse: [], users: notice.groups.map((group) => group.senderDiscordUserId), roles: [] },
      });
      return { messageId: message.id };
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      throw new ReminderDeliveryError(error instanceof Error ? error.message : "DISCORD_SEND_FAILED", status === 429 || status >= 500);
    }
  }
}

import type { ReminderService } from "../application/reminder-service.js";
import { logger } from "../logger.js";
import { ReminderDeliveryError, type ReminderSender } from "./discord-sender.js";

const POLL_INTERVAL_MS = 60_000;

export class ReminderWorker {
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private running = false;

  constructor(private readonly service: ReminderService, private readonly sender: ReminderSender) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const recovered = this.service.recover();
    if (recovered > 0) logger.warn("Recovered interrupted reminder deliveries without retry", { count: recovered });
    this.schedulePoll();
    this.timer = setInterval(() => this.schedulePoll(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activePoll;
  }

  private schedulePoll(): void {
    if (!this.running || this.activePoll) return;
    this.activePoll = this.poll().catch((error: unknown) => {
      logger.error("Reminder worker poll failed", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this.activePoll = undefined; });
  }

  private async poll(): Promise<void> {
    while (this.running) {
      let claim;
      try {
        claim = this.service.claimNext();
      } catch (error) {
        logger.error("Reminder claim failed", { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!claim) return;
      try {
        const notice = this.service.prepareDelivery(claim.logId);
        if (!notice) continue;
        const result = await this.sender.send(notice, () => this.service.isDeliveryValid(claim.logId));
        if (result) this.service.markSent(claim.logId, result.messageId);
        else this.service.markFailed(claim.logId, "DELIVERY_CANCELLED", false);
      } catch (error) {
        const retryable = error instanceof ReminderDeliveryError && error.retryable;
        this.service.markFailed(claim.logId, error instanceof Error ? error.message : String(error), retryable);
        logger.error("Reminder delivery failed", { logId: claim.logId, retryable, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

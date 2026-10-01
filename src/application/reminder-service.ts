import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ApplicationError } from "./errors.js";
import type { ServiceScope } from "./types.js";

type Row = Record<string, unknown>;
type Clock = () => number;
type IdFactory = () => string;
export const MIN_REMINDER_INTERVAL_SECONDS = 3600;
export const DEFAULT_REMINDER_INTERVAL_SECONDS = 86400;

export interface ReminderSettingDto {
  id: string; sessionId: string; settlementId: string; enabled: boolean; channelId: string;
  firstReminderAt: number; intervalSeconds: number; nextReminderAt: number | null;
  lastReminderAt: number | null; updatedAt: number;
}
export interface ReminderNotice {
  logId: string; guildDiscordId: string; channelId: string; sessionId: string; sessionName: string;
  settlementId: string; settlementVersion: number;
  groups: Array<{ senderDiscordUserId: string; transfers: Array<{ transferId: string; recipientDiscordUserId: string; amount: number }> }>;
}
export interface ReminderClaim { logId: string; deliveryKind: "AUTO" | "MANUAL"; notice: ReminderNotice; }
export interface ConfigureReminderInput { channelId: string; firstReminderAt?: number; intervalSeconds?: number; }

function fail(code: ConstructorParameters<typeof ApplicationError>[0], message: string, context: Readonly<Record<string, string | number>> = {}): never {
  throw new ApplicationError(code, message, context);
}
const text = (value: string, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") fail("INVALID_INPUT", `${name} must not be blank.`);
  return value.trim();
};
const safeTimestamp = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_INPUT", `${name} must be a non-negative safe integer timestamp.`);
  return value;
};

export class ReminderService {
  constructor(private readonly database: Database.Database, private readonly now: Clock = Date.now, private readonly createId: IdFactory = randomUUID) {}

  get(scope: ServiceScope): ReminderSettingDto | null {
    return this.transaction(() => {
      const { session } = this.authorized(scope, false);
      this.assertCurrentSettling(session);
      const row = this.database.prepare("SELECT * FROM reminder_settings WHERE session_id = ? AND settlement_id = ?")
        .get(session.id, this.currentSettlementId(String(session.id))) as Row | undefined;
      return row ? this.toSetting(row) : null;
    });
  }

  configure(scope: ServiceScope, input: ConfigureReminderInput): ReminderSettingDto {
    const channelId = text(input.channelId, "channelId");
    const intervalSeconds = input.intervalSeconds ?? DEFAULT_REMINDER_INTERVAL_SECONDS;
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < MIN_REMINDER_INTERVAL_SECONDS) {
      fail("INVALID_INPUT", `intervalSeconds must be at least ${MIN_REMINDER_INTERVAL_SECONDS}.`);
    }
    const providedFirstAt = input.firstReminderAt === undefined ? undefined : safeTimestamp(input.firstReminderAt, "firstReminderAt");
    return this.transaction(() => {
      const { session } = this.authorized(scope, true);
      const settlementId = this.assertCurrentSettling(session);
      this.assertUnpaid(String(session.id), settlementId);
      const timestamp = safeTimestamp(this.now(), "now");
      const firstReminderAt = providedFirstAt ?? this.checkedAdd(timestamp, intervalSeconds * 1000, "firstReminderAt");
      const nextReminderAt = Math.max(firstReminderAt, timestamp);
      const current = this.database.prepare("SELECT id, last_reminder_at, created_at FROM reminder_settings WHERE session_id = ?")
        .get(session.id) as Row | undefined;
      const id = current ? String(current.id) : this.createId();
      this.database.prepare(`INSERT INTO reminder_settings
        (id, session_id, settlement_id, enabled, channel_id, first_reminder_at, interval_seconds, next_reminder_at, last_reminder_at, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET settlement_id = excluded.settlement_id, enabled = 1, channel_id = excluded.channel_id,
          first_reminder_at = excluded.first_reminder_at, interval_seconds = excluded.interval_seconds,
          next_reminder_at = excluded.next_reminder_at, updated_at = excluded.updated_at`)
        .run(id, session.id, settlementId, channelId, firstReminderAt, intervalSeconds, nextReminderAt,
          current?.last_reminder_at ?? null, current?.created_at ?? timestamp, timestamp);
      return this.readSetting(String(session.id));
    });
  }

  stop(scope: ServiceScope): ReminderSettingDto | null {
    return this.transaction(() => {
      const { session } = this.authorized(scope, true);
      const settlementId = this.assertCurrentSettling(session);
      const timestamp = safeTimestamp(this.now(), "now");
      this.database.prepare("UPDATE reminder_settings SET enabled = 0, next_reminder_at = NULL, updated_at = ? WHERE session_id = ? AND settlement_id = ?")
        .run(timestamp, session.id, settlementId);
      const row = this.database.prepare("SELECT * FROM reminder_settings WHERE session_id = ? AND settlement_id = ?").get(session.id, settlementId) as Row | undefined;
      return row ? this.toSetting(row) : null;
    });
  }

  claimManual(scope: ServiceScope): ReminderClaim {
    return this.transaction(() => {
      const { session } = this.authorized(scope, true);
      const settlementId = this.assertCurrentSettling(session);
      this.assertUnpaid(String(session.id), settlementId);
      const setting = this.database.prepare("SELECT * FROM reminder_settings WHERE session_id = ? AND settlement_id = ?")
        .get(session.id, settlementId) as Row | undefined;
      if (!setting) fail("REMINDER_NOT_CONFIGURED", "Configure automatic reminders before sending a manual reminder.");
      const pending = this.database.prepare(`SELECT 1 FROM reminder_logs WHERE setting_id = ?
        AND (status = 'PROCESSING' OR (status = 'FAILED' AND next_attempt_at IS NOT NULL)) LIMIT 1`).get(setting.id);
      if (pending) fail("REMINDER_RATE_LIMITED", "A reminder is already being delivered.");
      const timestamp = safeTimestamp(this.now(), "now");
      const last = setting.last_reminder_at === null ? null : Number(setting.last_reminder_at);
      if (last !== null && timestamp < this.checkedAdd(last, MIN_REMINDER_INTERVAL_SECONDS * 1000, "nextAllowedAt")) {
        fail("REMINDER_RATE_LIMITED", "A reminder was sent recently.", { nextAllowedAt: this.checkedAdd(last, MIN_REMINDER_INTERVAL_SECONDS * 1000, "nextAllowedAt") });
      }
      const scheduledAt = this.nextUniqueScheduledAt(String(setting.id), timestamp);
      const logId = this.createId();
      this.database.prepare(`INSERT INTO reminder_logs
        (id, setting_id, session_id, settlement_id, scheduled_at, status, attempt_count, started_at, delivery_kind, channel_id)
        VALUES (?, ?, ?, ?, ?, 'PROCESSING', 1, ?, 'MANUAL', ?)`)
        .run(logId, setting.id, session.id, settlementId, scheduledAt, timestamp, setting.channel_id);
      return this.claimDto(logId, "MANUAL");
    });
  }

  recover(): number {
    return this.transaction(() => {
      const timestamp = safeTimestamp(this.now(), "now");
      // Discord may have accepted an in-flight send before a crash, so orphaned claims are never retried.
      const result = this.database.prepare(`UPDATE reminder_logs SET status = 'FAILED', next_attempt_at = NULL,
        completed_at = ?, last_error = 'DELIVERY_OUTCOME_UNKNOWN' WHERE status = 'PROCESSING'`).run(timestamp);
      return result.changes;
    });
  }

  claimNext(): ReminderClaim | null {
    return this.transaction(() => {
      const timestamp = safeTimestamp(this.now(), "now");
      const retry = this.database.prepare(`SELECT l.id FROM reminder_logs l
        WHERE l.status = 'FAILED' AND l.next_attempt_at <= ?
          AND NOT EXISTS (SELECT 1 FROM reminder_logs p WHERE p.setting_id = l.setting_id AND p.status = 'PROCESSING')
        ORDER BY l.next_attempt_at, l.id LIMIT 1`).get(timestamp) as Row | undefined;
      if (retry) {
        const logId = String(retry.id);
        if (!this.isLogValid(logId)) {
          this.database.prepare("UPDATE reminder_logs SET next_attempt_at = NULL, last_error = 'DELIVERY_CANCELLED', completed_at = ? WHERE id = ? AND status = 'FAILED'").run(timestamp, logId);
          return null;
        }
        const update = this.database.prepare("UPDATE reminder_logs SET status = 'PROCESSING', attempt_count = attempt_count + 1, next_attempt_at = NULL, started_at = ?, completed_at = NULL WHERE id = ? AND status = 'FAILED'").run(timestamp, logId);
        if (update.changes !== 1) return null;
        const kind = this.logKind(logId);
        return this.claimDto(logId, kind);
      }
      const setting = this.database.prepare(`SELECT rs.id, rs.session_id, rs.settlement_id, rs.channel_id, rs.next_reminder_at
        FROM reminder_settings rs JOIN sessions s ON s.id = rs.session_id
        JOIN settlements st ON st.id = rs.settlement_id AND st.session_id = rs.session_id
        WHERE rs.enabled = 1 AND rs.next_reminder_at <= ? AND s.status = 'SETTLING' AND st.status = 'FINALIZED'
          AND EXISTS (SELECT 1 FROM settlement_transfers t WHERE t.session_id = rs.session_id AND t.settlement_id = rs.settlement_id AND t.status = 'UNPAID')
          AND NOT EXISTS (SELECT 1 FROM reminder_logs l WHERE l.setting_id = rs.id AND l.status = 'PROCESSING')
          AND NOT EXISTS (SELECT 1 FROM reminder_logs l WHERE l.setting_id = rs.id AND l.status = 'FAILED' AND l.next_attempt_at IS NOT NULL)
        ORDER BY rs.next_reminder_at, rs.id LIMIT 1`).get(timestamp) as Row | undefined;
      if (!setting) return null;
      const scheduledAt = Number(setting.next_reminder_at);
      const logId = this.createId();
      this.database.prepare(`INSERT INTO reminder_logs
        (id, setting_id, session_id, settlement_id, scheduled_at, status, attempt_count, started_at, delivery_kind, channel_id)
        VALUES (?, ?, ?, ?, ?, 'PROCESSING', 1, ?, 'AUTO', ?)`)
        .run(logId, setting.id, setting.session_id, setting.settlement_id, scheduledAt, timestamp, setting.channel_id);
      const intervalSeconds = Number((this.database.prepare("SELECT interval_seconds FROM reminder_settings WHERE id = ?").get(setting.id) as Row).interval_seconds);
      this.database.prepare("UPDATE reminder_settings SET next_reminder_at = ?, updated_at = ? WHERE id = ? AND enabled = 1")
        .run(this.checkedAdd(timestamp, intervalSeconds * 1000, "nextReminderAt"), timestamp, setting.id);
      return this.claimDto(logId, "AUTO");
    });
  }

  prepareDelivery(logIdValue: string): ReminderNotice | null {
    const logId = text(logIdValue, "logId");
    return this.transaction(() => {
      if (!this.isLogValid(logId)) {
        this.database.prepare("UPDATE reminder_logs SET status = 'FAILED', next_attempt_at = NULL, completed_at = ?, last_error = 'DELIVERY_CANCELLED' WHERE id = ? AND status = 'PROCESSING'")
          .run(safeTimestamp(this.now(), "now"), logId);
        return null;
      }
      return this.buildNotice(logId);
    });
  }

  isDeliveryValid(logIdValue: string): boolean {
    const logId = text(logIdValue, "logId");
    return this.transaction(() => this.isLogValid(logId));
  }

  markSent(logIdValue: string, messageId: string): void {
    const logId = text(logIdValue, "logId"), id = text(messageId, "messageId");
    this.transaction(() => {
      const timestamp = safeTimestamp(this.now(), "now");
      const log = this.database.prepare("SELECT setting_id, settlement_id, session_id FROM reminder_logs WHERE id = ? AND status = 'PROCESSING'").get(logId) as Row | undefined;
      if (!log) return;
      this.database.prepare("UPDATE reminder_logs SET status = 'SENT', completed_at = ?, discord_message_id = ?, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND status = 'PROCESSING'")
        .run(timestamp, id, logId);
      this.database.prepare("UPDATE reminder_settings SET last_reminder_at = ?, updated_at = ? WHERE id = ? AND session_id = ? AND settlement_id = ?")
        .run(timestamp, timestamp, log.setting_id, log.session_id, log.settlement_id);
    });
  }

  markFailed(logIdValue: string, errorValue: string, retryable: boolean): void {
    const logId = text(logIdValue, "logId"), error = text(errorValue, "error").slice(0, 500);
    this.transaction(() => {
      const timestamp = safeTimestamp(this.now(), "now");
      const log = this.database.prepare("SELECT attempt_count FROM reminder_logs WHERE id = ? AND status = 'PROCESSING'").get(logId) as Row | undefined;
      if (!log) return;
      const attempt = Number(log.attempt_count);
      const retryAt = retryable && attempt < 3 ? this.checkedAdd(timestamp, (attempt === 1 ? 60 : 300) * 1000, "nextAttemptAt") : null;
      this.database.prepare("UPDATE reminder_logs SET status = 'FAILED', completed_at = ?, next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'PROCESSING'")
        .run(timestamp, retryAt, error, logId);
    });
  }

  private authorized(scope: ServiceScope, creatorOnly: boolean): { session: Row; actor: string } {
    const guild = text(scope.guildDiscordId, "guildDiscordId"), actor = text(scope.actorDiscordUserId, "actorDiscordUserId"), sessionId = text(scope.sessionId, "sessionId");
    const session = this.database.prepare("SELECT s.* FROM sessions s JOIN guilds g ON g.id = s.guild_id WHERE s.id = ? AND g.discord_guild_id = ?")
      .get(sessionId, guild) as Row | undefined;
    if (!session) fail("NOT_FOUND", "Session not found.");
    const member = this.database.prepare("SELECT 1 FROM session_members WHERE session_id = ? AND discord_user_id = ? AND removed_at IS NULL").get(sessionId, actor);
    if (session.creator_discord_user_id !== actor && !member) fail("FORBIDDEN", "Only the creator or an active participant can access this session.");
    if (creatorOnly && session.creator_discord_user_id !== actor) fail("FORBIDDEN", "Only the session creator can configure reminders.");
    return { session, actor };
  }

  private assertCurrentSettling(session: Row): string {
    if (session.status !== "SETTLING") fail("SESSION_NOT_SETTLING", "The session is not settling.");
    return this.currentSettlementId(String(session.id));
  }

  private currentSettlementId(sessionId: string): string {
    const row = this.database.prepare("SELECT id FROM settlements WHERE session_id = ? AND status = 'FINALIZED'").get(sessionId) as Row | undefined;
    if (!row) fail("SETTLEMENT_NOT_CURRENT", "There is no current finalized settlement.");
    return String(row.id);
  }

  private assertUnpaid(sessionId: string, settlementId: string): void {
    if (!this.database.prepare("SELECT 1 FROM settlement_transfers WHERE session_id = ? AND settlement_id = ? AND status = 'UNPAID' LIMIT 1").get(sessionId, settlementId)) {
      fail("NO_UNPAID_TRANSFERS", "There are no unpaid transfers to remind.");
    }
  }

  private readSetting(sessionId: string): ReminderSettingDto {
    const row = this.database.prepare("SELECT * FROM reminder_settings WHERE session_id = ?").get(sessionId) as Row;
    return this.toSetting(row);
  }

  private toSetting(row: Row): ReminderSettingDto {
    return { id: String(row.id), sessionId: String(row.session_id), settlementId: String(row.settlement_id), enabled: Number(row.enabled) === 1,
      channelId: String(row.channel_id), firstReminderAt: Number(row.first_reminder_at), intervalSeconds: Number(row.interval_seconds),
      nextReminderAt: row.next_reminder_at === null ? null : Number(row.next_reminder_at), lastReminderAt: row.last_reminder_at === null ? null : Number(row.last_reminder_at), updatedAt: Number(row.updated_at) };
  }

  private isLogValid(logId: string): boolean {
    const row = this.database.prepare(`SELECT l.delivery_kind, l.setting_id, l.settlement_id, l.session_id,
        rs.enabled, rs.settlement_id AS current_setting_settlement_id, s.status AS session_status,
        st.status AS settlement_status
      FROM reminder_logs l JOIN reminder_settings rs ON rs.id = l.setting_id AND rs.session_id = l.session_id
      JOIN sessions s ON s.id = l.session_id
      JOIN settlements st ON st.id = l.settlement_id AND st.session_id = l.session_id
      WHERE l.id = ? AND l.status = 'PROCESSING'`).get(logId) as Row | undefined;
    if (!row || row.session_status !== "SETTLING" || row.settlement_status !== "FINALIZED" || row.current_setting_settlement_id !== row.settlement_id) return false;
    if (row.delivery_kind === "AUTO" && Number(row.enabled) !== 1) return false;
    return Boolean(this.database.prepare("SELECT 1 FROM settlement_transfers WHERE session_id = ? AND settlement_id = ? AND status = 'UNPAID' LIMIT 1").get(row.session_id, row.settlement_id));
  }

  private claimDto(logId: string, deliveryKind: "AUTO" | "MANUAL"): ReminderClaim {
    const notice = this.buildNotice(logId);
    if (!notice) fail("SETTLEMENT_NOT_CURRENT", "The reminder delivery is no longer current.");
    return { logId, deliveryKind, notice };
  }

  private buildNotice(logId: string): ReminderNotice | null {
    const head = this.database.prepare(`SELECT l.id AS log_id, l.channel_id, l.session_id, l.settlement_id,
        g.discord_guild_id, s.name AS session_name, st.version
      FROM reminder_logs l JOIN sessions s ON s.id = l.session_id JOIN guilds g ON g.id = s.guild_id
      JOIN settlements st ON st.id = l.settlement_id AND st.session_id = l.session_id WHERE l.id = ? AND l.status = 'PROCESSING'`).get(logId) as Row | undefined;
    if (!head) return null;
    const rows = this.database.prepare(`SELECT t.id AS transfer_id, sender.discord_user_id AS sender_id,
        recipient.discord_user_id AS recipient_id, t.amount
      FROM settlement_transfers t
      JOIN session_members sender ON sender.id = t.from_member_id AND sender.session_id = t.session_id
      JOIN session_members recipient ON recipient.id = t.to_member_id AND recipient.session_id = t.session_id
      WHERE t.session_id = ? AND t.settlement_id = ? AND t.status = 'UNPAID'
      ORDER BY sender.discord_user_id, recipient.discord_user_id, t.id`).all(head.session_id, head.settlement_id) as Row[];
    if (!rows.length) return null;
    const grouped = new Map<string, ReminderNotice["groups"][number]["transfers"]>();
    for (const row of rows) {
      const sender = String(row.sender_id), transfers = grouped.get(sender) ?? [];
      transfers.push({ transferId: String(row.transfer_id), recipientDiscordUserId: String(row.recipient_id), amount: Number(row.amount) });
      grouped.set(sender, transfers);
    }
    return { logId: String(head.log_id), guildDiscordId: String(head.discord_guild_id), channelId: String(head.channel_id),
      sessionId: String(head.session_id), sessionName: String(head.session_name), settlementId: String(head.settlement_id),
      settlementVersion: Number(head.version), groups: [...grouped].map(([senderDiscordUserId, transfers]) => ({ senderDiscordUserId, transfers })) };
  }

  private logKind(logId: string): "AUTO" | "MANUAL" {
    return String((this.database.prepare("SELECT delivery_kind FROM reminder_logs WHERE id = ?").get(logId) as Row).delivery_kind) as "AUTO" | "MANUAL";
  }

  private nextUniqueScheduledAt(settingId: string, timestamp: number): number {
    const row = this.database.prepare(`SELECT MAX(scheduled_at) AS scheduled_at,
        (SELECT next_reminder_at FROM reminder_settings WHERE id = ?) AS next_reminder_at
      FROM reminder_logs WHERE setting_id = ?`).get(settingId, settingId) as Row;
    const last = row.scheduled_at === null ? null : Number(row.scheduled_at);
    let candidate = last !== null && last >= timestamp ? this.checkedAdd(last, 1, "scheduledAt") : timestamp;
    if (row.next_reminder_at !== null && candidate === Number(row.next_reminder_at)) candidate = this.checkedAdd(candidate, 1, "scheduledAt");
    return candidate;
  }

  private checkedAdd(value: number, delta: number, name: string): number {
    const result = value + delta;
    if (!Number.isSafeInteger(result) || result < 0) fail("INVALID_INPUT", `${name} exceeds the safe timestamp range.`);
    return result;
  }

  private transaction<T>(operation: () => T): T {
    try { return this.database.transaction(operation).immediate(); } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) fail("STORAGE_BUSY", "Storage is busy; retry the operation.");
      if (message.includes("SQLITE_CONSTRAINT")) fail("INVARIANT_VIOLATION", "The reminder operation violates a data constraint.");
      throw error;
    }
  }
}

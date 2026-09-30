import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { calculateSettlement } from "../domain/settlement/calculator.js";
import { SettlementCalculationError } from "../domain/settlement/errors.js";
import type { SettlementCalculation } from "../domain/settlement/types.js";
import { ApplicationError } from "./errors.js";
import { logger } from "../logger.js";
import type { ServiceScope } from "./types.js";

type Row = Record<string, unknown>;
type IdFactory = () => string;
type Clock = () => number;
export interface SettlementSnapshotDto {
  id: string; sessionId: string; version: number; status: "FINALIZED" | "INVALIDATED"; totalAmount: number;
  createdByDiscordUserId: string; createdAt: number; finalizedAt: number; invalidatedAt: number | null;
  balances: Array<{ memberId: string; shareAmount: number; paidAmount: number; balance: number }>;
  transfers: Array<{ id: string; fromMemberId: string; toMemberId: string; amount: number; status: "UNPAID" | "PAID"; paidAt: number | null }>;
}
export interface SettlementPreviewDto extends SettlementCalculation { nextVersion: number; }
export interface SettlementMutationResult { settlement: SettlementSnapshotDto; sessionRevision: number; becameAllPaid?: boolean; }

function fail(code: ConstructorParameters<typeof ApplicationError>[0], message: string, context: Readonly<Record<string, string | number>> = {}): never { throw new ApplicationError(code, message, context); }
const nonblank = (value: string, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") fail("INVALID_INPUT", `${name} must not be blank.`);
  return value.trim();
};

export class SettlementService {
  constructor(private readonly database: Database.Database, private readonly now: Clock = Date.now, private readonly createId: IdFactory = randomUUID) {}

  preview(scope: ServiceScope): SettlementPreviewDto {
    return this.transaction(() => {
      const { session } = this.authorized(scope, false);
      if (session.status !== "ACTIVE") fail("SESSION_NOT_ACTIVE", "The session is not active.");
      return { ...this.calculate(String(session.id)), nextVersion: this.nextVersion(String(session.id)) };
    });
  }

  getCurrent(scope: ServiceScope): SettlementSnapshotDto {
    return this.transaction(() => {
      const { session } = this.authorized(scope, false);
      const row = this.database.prepare("SELECT id FROM settlements WHERE session_id = ? AND status = 'FINALIZED'").get(session.id) as Row | undefined;
      if (!row) fail("SETTLEMENT_NOT_CURRENT", "There is no current finalized settlement.");
      return this.readSettlement(String(session.id), String(row.id));
    });
  }

  get(scope: ServiceScope, settlementId: string): SettlementSnapshotDto {
    const id = nonblank(settlementId, "settlementId");
    return this.transaction(() => {
      const { session } = this.authorized(scope, false);
      const row = this.database.prepare("SELECT id FROM settlements WHERE id = ? AND session_id = ?").get(id, session.id) as Row | undefined;
      if (!row) fail("SETTLEMENT_NOT_FOUND", "Settlement not found.");
      return this.readSettlement(String(session.id), id);
    });
  }

  list(scope: ServiceScope): SettlementSnapshotDto[] {
    return this.transaction(() => {
      const { session } = this.authorized(scope, false);
      const rows = this.database.prepare("SELECT id FROM settlements WHERE session_id = ? ORDER BY version DESC").all(session.id) as Row[];
      return rows.map((row) => this.readSettlement(String(session.id), String(row.id)));
    });
  }

  finalize(scope: ServiceScope, options: { expectedRevision: number }): SettlementMutationResult {
    const result = this.transaction(() => {
      const { session, actor } = this.authorized(scope, true, options.expectedRevision);
      if (session.status !== "ACTIVE") fail("SESSION_NOT_ACTIVE", "The session is not active.");
      const existing = this.database.prepare("SELECT 1 FROM settlements WHERE session_id = ? AND status = 'FINALIZED'").get(session.id);
      if (existing) fail("SETTLEMENT_NOT_CURRENT", "A finalized settlement already exists.");
      const calculation = this.calculate(String(session.id));
      const sessionId = String(session.id), timestamp = this.now(), settlementId = this.createId(), version = this.nextVersion(sessionId);
      this.database.prepare(`INSERT INTO settlements (id, session_id, version, status, total_amount, created_by_discord_user_id, created_at, finalized_at)
        VALUES (?, ?, ?, 'FINALIZED', ?, ?, ?, ?)`).run(settlementId, sessionId, version, calculation.totalAmount, actor, timestamp, timestamp);
      const insertBalance = this.database.prepare(`INSERT INTO settlement_balances (id, session_id, settlement_id, member_id, share_amount, paid_amount, balance, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const balance of calculation.balances) insertBalance.run(this.createId(), sessionId, settlementId, balance.memberId, balance.shareAmount, balance.paidAmount, balance.balance, timestamp);
      const insertTransfer = this.database.prepare(`INSERT INTO settlement_transfers (id, session_id, settlement_id, from_member_id, to_member_id, amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'UNPAID', ?, ?)`);
      for (const transfer of calculation.transfers) insertTransfer.run(this.createId(), sessionId, settlementId, transfer.fromMemberId, transfer.toMemberId, transfer.amount, timestamp, timestamp);
      this.bumpSession(sessionId, session.revision, timestamp, "SETTLING", timestamp, null);
      return { settlement: this.readSettlement(sessionId, settlementId), sessionRevision: Number(session.revision) + 1, becameAllPaid: calculation.transfers.length === 0 };
    });
    logger.info("Settlement finalized", { sessionId: result.settlement.sessionId, settlementId: result.settlement.id, version: result.settlement.version, transferCount: result.settlement.transfers.length });
    return result;
  }

  invalidate(scope: ServiceScope, settlementId: string, options: { expectedRevision: number }): SettlementMutationResult {
    const id = nonblank(settlementId, "settlementId");
    return this.transaction(() => {
      const { session, actor } = this.authorized(scope, true, options.expectedRevision);
      this.assertCurrentSettling(session, id);
      const timestamp = this.now();
      this.database.prepare("UPDATE settlements SET status = 'INVALIDATED', invalidated_at = ? WHERE id = ? AND session_id = ? AND status = 'FINALIZED'").run(timestamp, id, session.id);
      this.database.prepare("UPDATE reminder_settings SET enabled = 0, next_reminder_at = NULL, updated_at = ? WHERE session_id = ? AND settlement_id = ?").run(timestamp, session.id, id);
      this.bumpSession(String(session.id), session.revision, timestamp, "ACTIVE", null, null);
      return { settlement: this.readSettlement(String(session.id), id), sessionRevision: Number(session.revision) + 1 };
    });
  }

  setTransferStatus(scope: ServiceScope, settlementId: string, transferId: string, status: "PAID" | "UNPAID", options: { expectedRevision: number }): SettlementMutationResult {
    const id = nonblank(settlementId, "settlementId"), transfer = nonblank(transferId, "transferId");
    if (status !== "PAID" && status !== "UNPAID") fail("INVALID_INPUT", "Transfer status is invalid.");
    return this.transaction(() => {
      const { session, actor } = this.authorized(scope, false, options.expectedRevision);
      if (session.status !== "SETTLING") fail("SESSION_NOT_SETTLING", "The session is not settling.");
      const current = this.database.prepare("SELECT id FROM settlements WHERE id = ? AND session_id = ? AND status = 'FINALIZED'").get(id, session.id);
      if (!current) fail("SETTLEMENT_NOT_CURRENT", "The settlement is not current.");
      const row = this.database.prepare(`SELECT t.id, t.status, sender.discord_user_id AS sender_discord_user_id,
          recipient.discord_user_id AS recipient_discord_user_id
        FROM settlement_transfers t
        JOIN session_members sender ON sender.id = t.from_member_id AND sender.session_id = t.session_id
        JOIN session_members recipient ON recipient.id = t.to_member_id AND recipient.session_id = t.session_id
        WHERE t.id = ? AND t.session_id = ? AND t.settlement_id = ?`).get(transfer, session.id, id) as Row | undefined;
      if (!row) fail("TRANSFER_NOT_FOUND", "Transfer not found.");
      if (row.sender_discord_user_id !== actor && row.recipient_discord_user_id !== actor && session.creator_discord_user_id !== actor) fail("FORBIDDEN", "Only the creator or a transfer participant can change transfer status.");
      if (row.status !== status) {
        const timestamp = this.now();
        this.database.prepare("UPDATE settlement_transfers SET status = ?, paid_at = ?, updated_at = ? WHERE id = ? AND session_id = ? AND settlement_id = ?")
          .run(status, status === "PAID" ? timestamp : null, timestamp, transfer, session.id, id);
        this.bumpSession(String(session.id), session.revision, timestamp, "SETTLING", session.settling_at as number, null);
      }
      const allPaid = status === "PAID" && !this.database.prepare("SELECT 1 FROM settlement_transfers WHERE session_id = ? AND settlement_id = ? AND status = 'UNPAID' LIMIT 1").get(session.id, id);
      if (allPaid) this.database.prepare("UPDATE reminder_settings SET enabled = 0, next_reminder_at = NULL, updated_at = ? WHERE session_id = ? AND settlement_id = ?").run(this.now(), session.id, id);
      const becameAllPaid = row.status !== "PAID" && status === "PAID" && allPaid;
      return { settlement: this.readSettlement(String(session.id), id), sessionRevision: Number(session.revision) + (row.status === status ? 0 : 1), becameAllPaid: Boolean(becameAllPaid) };
    });
  }

  close(scope: ServiceScope, settlementId: string, options: { expectedRevision: number }): SettlementMutationResult {
    const id = nonblank(settlementId, "settlementId");
    return this.transaction(() => {
      const { session } = this.authorized(scope, true, options.expectedRevision);
      this.assertCurrentSettling(session, id);
      if (this.database.prepare("SELECT 1 FROM settlement_transfers WHERE session_id = ? AND settlement_id = ? AND status = 'UNPAID' LIMIT 1").get(session.id, id)) fail("UNPAID_TRANSFERS", "All transfers must be paid before closing.");
      const timestamp = this.now();
      this.database.prepare("UPDATE reminder_settings SET enabled = 0, next_reminder_at = NULL, updated_at = ? WHERE session_id = ? AND settlement_id = ?").run(timestamp, session.id, id);
      this.bumpSession(String(session.id), session.revision, timestamp, "CLOSED", session.settling_at as number, timestamp);
      return { settlement: this.readSettlement(String(session.id), id), sessionRevision: Number(session.revision) + 1 };
    });
  }

  private calculate(sessionId: string): SettlementCalculation {
    const members = this.database.prepare("SELECT id, weight, fixed_adjustment FROM session_members WHERE session_id = ? AND removed_at IS NULL ORDER BY id").all(sessionId) as Row[];
    if (!members.length) fail("EMPTY_MEMBERS", "A settlement requires at least one active member.");
    const expenses = this.database.prepare("SELECT id, amount, payer_member_id FROM expenses WHERE session_id = ? ORDER BY id").all(sessionId) as Row[];
    const input = { members: members.map((r) => ({ id: String(r.id), weight: Number(r.weight), fixedAdjustment: Number(r.fixed_adjustment) })), expenses: expenses.map((r) => ({
      id: String(r.id), amount: Number(r.amount), payerMemberId: String(r.payer_member_id), eligibleMemberIds: (this.database.prepare("SELECT member_id FROM expense_members WHERE session_id = ? AND expense_id = ? ORDER BY member_id").all(sessionId, r.id) as Row[]).map((m) => String(m.member_id)),
    })) };
    try { return calculateSettlement(input); } catch (error) {
      if (error instanceof SettlementCalculationError) {
        const code = error.code === "EMPTY_ELIGIBLE_MEMBERS" ? "EMPTY_EXPENSE_MEMBERS" : error.code;
        fail(code as ConstructorParameters<typeof ApplicationError>[0], error.message, error.context);
      }
      throw error;
    }
  }

  private nextVersion(sessionId: string): number {
    return Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM settlements WHERE session_id = ?").get(sessionId) as Row).version);
  }

  private readSettlement(sessionId: string, settlementId: string): SettlementSnapshotDto {
    const row = this.database.prepare("SELECT * FROM settlements WHERE id = ? AND session_id = ?").get(settlementId, sessionId) as Row | undefined;
    if (!row) fail("SETTLEMENT_NOT_FOUND", "Settlement not found.");
    const balances = this.database.prepare("SELECT member_id, share_amount, paid_amount, balance FROM settlement_balances WHERE session_id = ? AND settlement_id = ? ORDER BY member_id").all(sessionId, settlementId) as Row[];
    const transfers = this.database.prepare("SELECT id, from_member_id, to_member_id, amount, status, paid_at FROM settlement_transfers WHERE session_id = ? AND settlement_id = ? ORDER BY id").all(sessionId, settlementId) as Row[];
    return { id: String(row.id), sessionId, version: Number(row.version), status: row.status as SettlementSnapshotDto["status"], totalAmount: Number(row.total_amount), createdByDiscordUserId: String(row.created_by_discord_user_id), createdAt: Number(row.created_at), finalizedAt: Number(row.finalized_at), invalidatedAt: row.invalidated_at === null ? null : Number(row.invalidated_at), balances: balances.map((b) => ({ memberId: String(b.member_id), shareAmount: Number(b.share_amount), paidAmount: Number(b.paid_amount), balance: Number(b.balance) })), transfers: transfers.map((t) => ({ id: String(t.id), fromMemberId: String(t.from_member_id), toMemberId: String(t.to_member_id), amount: Number(t.amount), status: t.status as "PAID" | "UNPAID", paidAt: t.paid_at === null ? null : Number(t.paid_at) })) };
  }

  private authorized(scope: ServiceScope, creatorOnly: boolean, expectedRevision?: number): { session: Row; actor: string } {
    const guild = nonblank(scope.guildDiscordId, "guildDiscordId"), actor = nonblank(scope.actorDiscordUserId, "actorDiscordUserId"), sessionId = nonblank(scope.sessionId, "sessionId");
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail("INVALID_INPUT", "expectedRevision must be a non-negative safe integer.");
    const session = this.database.prepare("SELECT s.* FROM sessions s JOIN guilds g ON g.id = s.guild_id WHERE s.id = ? AND g.discord_guild_id = ?").get(sessionId, guild) as Row | undefined;
    if (!session) fail("NOT_FOUND", "Session not found.");
    const member = this.database.prepare("SELECT 1 FROM session_members WHERE session_id = ? AND discord_user_id = ? AND removed_at IS NULL").get(sessionId, actor);
    if (session.creator_discord_user_id !== actor && !member) fail("FORBIDDEN", "Only the creator or an active participant can access this session.");
    if (creatorOnly && session.creator_discord_user_id !== actor) fail("FORBIDDEN", "Only the session creator can make this change.");
    if (expectedRevision !== undefined && Number(session.revision) !== expectedRevision) fail("REVISION_CONFLICT", "The session changed since it was last read.", { currentRevision: Number(session.revision) });
    return { session, actor };
  }

  private assertCurrentSettling(session: Row, settlementId: string): void {
    if (session.status !== "SETTLING") fail("SESSION_NOT_SETTLING", "The session is not settling.");
    const current = this.database.prepare("SELECT 1 FROM settlements WHERE id = ? AND session_id = ? AND status = 'FINALIZED'").get(settlementId, session.id);
    if (!current) fail("SETTLEMENT_NOT_CURRENT", "The settlement is not current.");
  }

  private bumpSession(sessionId: string, revision: unknown, timestamp: number, status: string, settlingAt: number | null, closedAt: number | null): void {
    const result = this.database.prepare(`UPDATE sessions SET status = ?, settling_at = ?, closed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(status, settlingAt, closedAt, timestamp, sessionId, revision);
    if (result.changes !== 1) fail("REVISION_CONFLICT", "The session changed during the operation.");
  }

  private transaction<T>(operation: () => T): T {
    try { return this.database.transaction(operation).immediate(); } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) fail("STORAGE_BUSY", "Storage is busy; retry the operation.");
      if (message.includes("SQLITE_CONSTRAINT")) fail("INVARIANT_VIOLATION", "The settlement operation violates a data constraint.");
      throw error;
    }
  }
}

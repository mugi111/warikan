import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { calculateSettlement } from "../domain/settlement/calculator.js";
import { SettlementCalculationError } from "../domain/settlement/errors.js";
import { ApplicationError } from "./errors.js";
import { logger } from "../logger.js";
import type {
  CreateSessionInput, ExpenseDto, ExpenseInput, MemberDto, MemberSettingsInput,
  RevisionOptions, SessionDto, ServiceScope,
} from "./types.js";

type Row = Record<string, unknown>;
type Clock = () => number;
type IdFactory = () => string;

function inputError(message: string): never {
  throw new ApplicationError("INVALID_INPUT", message);
}

function text(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) inputError(`${field} must not be blank.`);
  return value.trim();
}

function positiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) inputError("Amount must be a positive safe integer.");
  return value;
}

function mapCalculationError(error: unknown): never {
  if (error instanceof SettlementCalculationError) {
    const map = {
      ADJUSTMENTS_NOT_ZERO: "ADJUSTMENTS_NOT_ZERO",
      NEGATIVE_SHARE: "NEGATIVE_SHARE",
      AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
      EMPTY_ELIGIBLE_MEMBERS: "EMPTY_EXPENSE_MEMBERS",
      DUPLICATE_MEMBER: "DUPLICATE_MEMBER",
      DUPLICATE_ELIGIBLE_MEMBER: "DUPLICATE_MEMBER",
    } as const;
    const code = map[error.code as keyof typeof map] ?? "INVALID_INPUT";
    throw new ApplicationError(code, error.message, error.context);
  }
  throw error;
}

export class SessionService {
  constructor(
    private readonly database: Database.Database,
    private readonly now: Clock = Date.now,
    private readonly createId: IdFactory = randomUUID,
  ) {}

  createSession(input: CreateSessionInput): SessionDto {
    const guildDiscordId = text(input.guildDiscordId, "guildDiscordId");
    const actor = text(input.actorDiscordUserId, "actorDiscordUserId");
    const name = text(input.name, "name");
    const session = this.transaction(() => {
      const timestamp = this.now();
      let guild = this.database.prepare("SELECT id FROM guilds WHERE discord_guild_id = ?").get(guildDiscordId) as Row | undefined;
      if (!guild) {
        const guildId = this.createId();
        this.database.prepare("INSERT INTO guilds (id, discord_guild_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(guildId, guildDiscordId, timestamp, timestamp);
        guild = { id: guildId };
      }
      const sessionId = this.createId();
      this.database.prepare(`INSERT INTO sessions
        (id, guild_id, name, status, creator_discord_user_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, 0, ?, ?)`).run(sessionId, guild.id, name, actor, timestamp, timestamp);
      this.database.prepare(`INSERT INTO session_members
        (id, session_id, discord_user_id, weight, fixed_adjustment, joined_at, updated_at)
        VALUES (?, ?, ?, 1, 0, ?, ?)`).run(this.createId(), sessionId, actor, timestamp, timestamp);
      return this.readSession(guildDiscordId, sessionId);
    });
    logger.info("Session created", { sessionId: session.id, guildDiscordId, actorDiscordUserId: actor });
    return session;
  }

  listSessions(guildDiscordId: string, actorDiscordUserId: string): SessionDto[] {
    const guild = text(guildDiscordId, "guildDiscordId");
    const actor = text(actorDiscordUserId, "actorDiscordUserId");
    return this.transaction(() => {
      const rows = this.database.prepare(`SELECT s.id FROM sessions s JOIN guilds g ON g.id = s.guild_id
        WHERE g.discord_guild_id = ? AND (s.creator_discord_user_id = ? OR EXISTS
          (SELECT 1 FROM session_members m WHERE m.session_id = s.id AND m.discord_user_id = ? AND m.removed_at IS NULL))
        ORDER BY s.updated_at DESC, s.id`).all(guild, actor) as Row[];
      return rows.map((row) => this.readSession(guild, String(row.id), actor));
    });
  }

  getSession(scope: ServiceScope): SessionDto {
    return this.transaction(() => this.readSession(text(scope.guildDiscordId, "guildDiscordId"), text(scope.sessionId, "sessionId"), text(scope.actorDiscordUserId, "actorDiscordUserId")));
  }

  renameSession(scope: ServiceScope, nameValue: string, options: RevisionOptions = {}): SessionDto {
    const name = text(nameValue, "name");
    return this.mutate(scope, options, ({ session, timestamp }) => {
      if (session.name === name) return false;
      this.database.prepare("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?").run(name, timestamp, session.id);
      return true;
    });
  }

  addMembers(scope: ServiceScope, discordUserIds: string[], options: RevisionOptions = {}): SessionDto {
    if (!Array.isArray(discordUserIds) || discordUserIds.length === 0) inputError("At least one member is required.");
    const ids = discordUserIds.map((id) => text(id, "discordUserId"));
    if (new Set(ids).size !== ids.length) throw new ApplicationError("DUPLICATE_MEMBER", "Member identifiers must be unique.");
    return this.mutate(scope, options, ({ session, timestamp }) => {
      let changed = false;
      for (const discordUserId of ids) {
        const existing = this.database.prepare("SELECT id, removed_at FROM session_members WHERE session_id = ? AND discord_user_id = ?")
          .get(session.id, discordUserId) as Row | undefined;
        if (existing && existing.removed_at === null) continue;
        if (existing) {
          this.database.prepare("UPDATE session_members SET removed_at = NULL, weight = 1, fixed_adjustment = 0, updated_at = ? WHERE id = ?")
            .run(timestamp, existing.id);
        } else {
          this.database.prepare(`INSERT INTO session_members
            (id, session_id, discord_user_id, weight, fixed_adjustment, joined_at, updated_at)
            VALUES (?, ?, ?, 1, 0, ?, ?)`).run(this.createId(), session.id, discordUserId, timestamp, timestamp);
        }
        changed = true;
      }
      return changed;
    });
  }

  removeMember(scope: ServiceScope, memberId: string, options: RevisionOptions = {}): SessionDto {
    const targetId = text(memberId, "memberId");
    return this.mutate(scope, options, ({ session, timestamp }) => {
      const member = this.database.prepare("SELECT id FROM session_members WHERE id = ? AND session_id = ? AND removed_at IS NULL")
        .get(targetId, session.id) as Row | undefined;
      if (!member) throw new ApplicationError("MEMBER_NOT_FOUND", "The active member was not found.");
      const used = this.database.prepare(`SELECT 1 FROM expenses e LEFT JOIN expense_members em ON em.expense_id = e.id
        WHERE e.session_id = ? AND (e.payer_member_id = ? OR em.member_id = ?) LIMIT 1`).get(session.id, targetId, targetId);
      if (used) throw new ApplicationError("MEMBER_IN_USE", "A member who paid or is included in an expense cannot be removed.");
      this.database.prepare("UPDATE session_members SET removed_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, targetId);
      return true;
    });
  }

  updateMemberSettings(scope: ServiceScope, settings: MemberSettingsInput[], options: RevisionOptions = {}): SessionDto {
    if (!Array.isArray(settings) || settings.length === 0) inputError("At least one member setting is required.");
    const seen = new Set<string>();
    for (const setting of settings) {
      text(setting.memberId, "memberId");
      if (seen.has(setting.memberId)) throw new ApplicationError("DUPLICATE_MEMBER", "Member settings must not contain duplicates.");
      seen.add(setting.memberId);
      if (!Number.isFinite(setting.weight) || setting.weight <= 0) inputError("Member weights must be positive finite numbers.");
      if (!Number.isSafeInteger(setting.fixedAdjustment)) inputError("Fixed adjustments must be safe integers.");
    }
    return this.mutate(scope, options, ({ session, timestamp }) => {
      let changed = false;
      for (const setting of settings) {
        const member = this.database.prepare(`SELECT id, weight, fixed_adjustment FROM session_members
          WHERE id = ? AND session_id = ? AND removed_at IS NULL`).get(setting.memberId, session.id) as Row | undefined;
        if (!member) throw new ApplicationError("MEMBER_NOT_FOUND", "The active member was not found.");
        if (Number(member.weight) !== setting.weight || Number(member.fixed_adjustment) !== setting.fixedAdjustment) {
          this.database.prepare("UPDATE session_members SET weight = ?, fixed_adjustment = ?, updated_at = ? WHERE id = ?")
            .run(setting.weight, setting.fixedAdjustment, timestamp, setting.memberId);
          changed = true;
        }
      }
      return changed;
    });
  }

  listExpenses(scope: ServiceScope): ExpenseDto[] {
    return this.getSession(scope).expenses;
  }

  createExpense(scope: ServiceScope, input: ExpenseInput, options: RevisionOptions = {}): SessionDto {
    const expense = this.normalizeExpense(input);
    return this.mutate(scope, options, ({ session, actor, timestamp }) => {
      const sessionId = String(session.id);
      const eligible = expense.eligibleMemberIds ?? this.activeMemberIds(sessionId);
      this.assertActiveMembers(sessionId, [expense.payerMemberId, ...eligible]);
      if (eligible.length === 0) throw new ApplicationError("EMPTY_EXPENSE_MEMBERS", "An expense must include at least one member.");
      const expenseId = this.createId();
      this.database.prepare(`INSERT INTO expenses
        (id, session_id, title, amount, payer_member_id, created_by_discord_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(expenseId, sessionId, expense.title, expense.amount, expense.payerMemberId, actor, timestamp, timestamp);
      const insert = this.database.prepare("INSERT INTO expense_members (expense_id, session_id, member_id, created_at) VALUES (?, ?, ?, ?)");
      for (const memberId of eligible) insert.run(expenseId, sessionId, memberId, timestamp);
      return true;
    }, true);
  }

  updateExpense(scope: ServiceScope, expenseIdValue: string, input: ExpenseInput, options: RevisionOptions = {}): SessionDto {
    const expenseId = text(expenseIdValue, "expenseId");
    const expense = this.normalizeExpense(input);
    return this.mutate(scope, options, ({ session, timestamp }) => {
      const sessionId = String(session.id);
      const existing = this.database.prepare("SELECT id FROM expenses WHERE id = ? AND session_id = ?").get(expenseId, sessionId);
      if (!existing) throw new ApplicationError("NOT_FOUND", "Expense not found.");
      const eligible = expense.eligibleMemberIds ?? this.activeMemberIds(sessionId);
      this.assertActiveMembers(sessionId, [expense.payerMemberId, ...eligible]);
      if (eligible.length === 0) throw new ApplicationError("EMPTY_EXPENSE_MEMBERS", "An expense must include at least one member.");
      const currentEligible = this.memberIdsForExpense(expenseId);
      const changed = this.database.prepare(`SELECT title, amount, payer_member_id FROM expenses WHERE id = ?`)
        .get(expenseId) as Row;
      const same = changed.title === expense.title && Number(changed.amount) === expense.amount
        && changed.payer_member_id === expense.payerMemberId
        && currentEligible.length === eligible.length && currentEligible.every((id, index) => id === [...eligible].sort()[index]);
      if (same) return false;
      this.database.prepare("UPDATE expenses SET title = ?, amount = ?, payer_member_id = ?, updated_at = ? WHERE id = ?")
        .run(expense.title, expense.amount, expense.payerMemberId, timestamp, expenseId);
      this.database.prepare("DELETE FROM expense_members WHERE expense_id = ?").run(expenseId);
      const insert = this.database.prepare("INSERT INTO expense_members (expense_id, session_id, member_id, created_at) VALUES (?, ?, ?, ?)");
      for (const memberId of eligible) insert.run(expenseId, sessionId, memberId, timestamp);
      return true;
    });
  }

  deleteExpense(scope: ServiceScope, expenseIdValue: string, options: RevisionOptions = {}): SessionDto {
    const expenseId = text(expenseIdValue, "expenseId");
    return this.mutate(scope, options, ({ session }) => {
      const result = this.database.prepare("DELETE FROM expenses WHERE id = ? AND session_id = ?").run(expenseId, session.id);
      if (result.changes === 0) throw new ApplicationError("NOT_FOUND", "Expense not found.");
      return true;
    });
  }

  private normalizeExpense(input: ExpenseInput): Required<Pick<ExpenseInput, "title" | "amount" | "payerMemberId">> & Pick<ExpenseInput, "eligibleMemberIds"> {
    const title = text(input.title, "title");
    const amount = positiveAmount(input.amount);
    const payerMemberId = text(input.payerMemberId, "payerMemberId");
    let eligibleMemberIds: string[] | undefined;
    if (input.eligibleMemberIds !== undefined) {
      if (!Array.isArray(input.eligibleMemberIds) || input.eligibleMemberIds.length === 0) {
        throw new ApplicationError("EMPTY_EXPENSE_MEMBERS", "An expense must include at least one member.");
      }
      eligibleMemberIds = input.eligibleMemberIds.map((id) => text(id, "eligibleMemberId"));
      if (new Set(eligibleMemberIds).size !== eligibleMemberIds.length) throw new ApplicationError("DUPLICATE_MEMBER", "Expense members must be unique.");
    }
    return { title, amount, payerMemberId, ...(eligibleMemberIds ? { eligibleMemberIds } : {}) };
  }

  private mutate(
    scope: ServiceScope,
    options: RevisionOptions,
    operation: (context: { session: Row; actor: string; timestamp: number }) => boolean,
    participantMayMutate = false,
  ): SessionDto {
    const guild = text(scope.guildDiscordId, "guildDiscordId");
    const actor = text(scope.actorDiscordUserId, "actorDiscordUserId");
    const sessionId = text(scope.sessionId, "sessionId");
    this.validateRevision(options.expectedRevision);
    return this.transaction(() => {
      const session = this.sessionRow(guild, sessionId);
      if (session.creator_discord_user_id !== actor) {
        const isParticipant = participantMayMutate && this.database.prepare(`SELECT 1 FROM session_members
          WHERE session_id = ? AND discord_user_id = ? AND removed_at IS NULL`).get(sessionId, actor);
        if (!isParticipant) throw new ApplicationError("FORBIDDEN", "Only the session creator can make this change.");
      }
      if (session.status !== "ACTIVE") throw new ApplicationError("SESSION_NOT_ACTIVE", "The session is not active.");
      if (options.expectedRevision !== undefined && Number(session.revision) !== options.expectedRevision) {
        throw new ApplicationError("REVISION_CONFLICT", "The session changed since it was last read.", { currentRevision: Number(session.revision) });
      }
      const timestamp = this.now();
      const changed = operation({ session, actor, timestamp });
      if (changed) {
        this.validateCandidate(String(session.id));
        const update = this.database.prepare(`UPDATE sessions SET revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'ACTIVE'`).run(timestamp, sessionId, session.revision);
        if (update.changes !== 1) throw new ApplicationError("REVISION_CONFLICT", "The session changed during the operation.");
      }
      return this.readSession(guild, sessionId, actor);
    });
  }

  private validateCandidate(sessionId: string): void {
    const members = this.database.prepare(`SELECT id, weight, fixed_adjustment FROM session_members
      WHERE session_id = ? AND removed_at IS NULL`).all(sessionId) as Row[];
    const expenses = this.loadExpenses(sessionId).map((expense) => ({
      id: expense.id, amount: expense.amount, payerMemberId: expense.payerMemberId, eligibleMemberIds: expense.eligibleMemberIds,
    }));
    if (members.length === 0 && expenses.length === 0) return;
    try {
      calculateSettlement({
        members: members.map((member) => ({ id: String(member.id), weight: Number(member.weight), fixedAdjustment: Number(member.fixed_adjustment) })),
        expenses,
      });
    } catch (error) {
      mapCalculationError(error);
    }
  }

  private assertActiveMembers(sessionId: string, memberIds: string[]): void {
    const active = new Set(this.activeMemberIds(sessionId));
    for (const memberId of memberIds) if (!active.has(memberId)) throw new ApplicationError("MEMBER_NOT_FOUND", "An active member was not found.");
  }

  private activeMemberIds(sessionId: string): string[] {
    return (this.database.prepare(`SELECT id FROM session_members WHERE session_id = ? AND removed_at IS NULL ORDER BY id`)
      .all(sessionId) as Row[]).map((row) => String(row.id));
  }

  private memberIdsForExpense(expenseId: string): string[] {
    return (this.database.prepare("SELECT member_id FROM expense_members WHERE expense_id = ? ORDER BY member_id").all(expenseId) as Row[])
      .map((row) => String(row.member_id));
  }

  private readSession(guildDiscordId: string, sessionId: string, actor?: string): SessionDto {
    const session = this.sessionRow(guildDiscordId, sessionId);
    if (actor !== undefined && session.creator_discord_user_id !== actor) {
      const member = this.database.prepare(`SELECT 1 FROM session_members WHERE session_id = ? AND discord_user_id = ? AND removed_at IS NULL`)
        .get(sessionId, actor);
      if (!member) throw new ApplicationError("FORBIDDEN", "Only the creator or an active participant can view this session.");
    }
    const members = this.database.prepare(`SELECT id, discord_user_id, weight, fixed_adjustment, joined_at, updated_at, removed_at
      FROM session_members WHERE session_id = ? ORDER BY joined_at, id`).all(sessionId) as Row[];
    return {
      id: String(session.id), guildDiscordId, name: String(session.name), status: session.status as SessionDto["status"],
      creatorDiscordUserId: String(session.creator_discord_user_id), revision: Number(session.revision),
      createdAt: Number(session.created_at), updatedAt: Number(session.updated_at),
      settlingAt: session.settling_at === null ? null : Number(session.settling_at),
      closedAt: session.closed_at === null ? null : Number(session.closed_at),
      members: members.map((member): MemberDto => ({
        id: String(member.id), discordUserId: String(member.discord_user_id), weight: Number(member.weight),
        fixedAdjustment: Number(member.fixed_adjustment), joinedAt: Number(member.joined_at), updatedAt: Number(member.updated_at),
        removedAt: member.removed_at === null ? null : Number(member.removed_at),
      })),
      expenses: this.loadExpenses(sessionId),
    };
  }

  private loadExpenses(sessionId: string): ExpenseDto[] {
    const rows = this.database.prepare(`SELECT id, title, amount, payer_member_id, created_by_discord_user_id, created_at, updated_at
      FROM expenses WHERE session_id = ? ORDER BY created_at, id`).all(sessionId) as Row[];
    return rows.map((row) => ({
      id: String(row.id), title: String(row.title), amount: Number(row.amount), payerMemberId: String(row.payer_member_id),
      eligibleMemberIds: this.memberIdsForExpense(String(row.id)), createdByDiscordUserId: String(row.created_by_discord_user_id),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
  }

  private sessionRow(guildDiscordId: string, sessionId: string): Row {
    const row = this.database.prepare(`SELECT s.* FROM sessions s JOIN guilds g ON g.id = s.guild_id
      WHERE s.id = ? AND g.discord_guild_id = ?`).get(sessionId, guildDiscordId) as Row | undefined;
    if (!row) throw new ApplicationError("NOT_FOUND", "Session not found.");
    return row;
  }

  private validateRevision(revision: number | undefined): void {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) inputError("expectedRevision must be a non-negative safe integer.");
  }

  private transaction<T>(operation: () => T): T {
    try {
      return this.database.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof SettlementCalculationError) mapCalculationError(error);
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) throw new ApplicationError("STORAGE_BUSY", "Storage is busy; retry the operation.");
      if (message.includes("SQLITE_CONSTRAINT")) throw new ApplicationError("INVALID_INPUT", "The operation violates a data constraint.");
      throw new ApplicationError("INVALID_INPUT", "The operation could not be completed.");
    }
  }
}

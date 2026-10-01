export type SessionStatus = "ACTIVE" | "SETTLING" | "CLOSED";

export interface MemberDto {
  id: string;
  discordUserId: string;
  weight: number;
  fixedAdjustment: number;
  joinedAt: number;
  updatedAt: number;
  removedAt: number | null;
}

export interface ExpenseDto {
  id: string;
  title: string;
  amount: number;
  payerMemberId: string;
  eligibleMemberIds: string[];
  createdByDiscordUserId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDto {
  id: string;
  guildDiscordId: string;
  name: string;
  status: SessionStatus;
  creatorDiscordUserId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  members: MemberDto[];
  expenses: ExpenseDto[];
}

export interface ServiceScope {
  guildDiscordId: string;
  actorDiscordUserId: string;
  sessionId: string;
}

export interface CreateSessionInput {
  guildDiscordId: string;
  actorDiscordUserId: string;
  name: string;
}

export interface MemberSettingsInput {
  memberId: string;
  weight: number;
  fixedAdjustment: number;
}

export interface ExpenseInput {
  title: string;
  amount: number;
  payerMemberId: string;
  eligibleMemberIds?: string[];
}

export interface RevisionOptions {
  expectedRevision?: number;
}

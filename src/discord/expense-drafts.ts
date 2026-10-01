import type { ExpenseDto, SessionDto } from "../application/types.js";
import { newDraftToken } from "./custom-id.js";

export interface ExpenseDraft {
  token: string; owner: string; guild: string; sessionId: string; revision: number;
  expenseId?: string; title: string; amount: string; payer: string; eligible: Set<string>;
  allEligible: boolean; memberPage: number; generation: number; expiresAt: number;
}

export class ExpenseDraftStore {
  private readonly drafts = new Map<string, ExpenseDraft>();
  private readonly maxDrafts = 500;

  create(owner: string, guild: string, session: SessionDto, expense?: ExpenseDto): ExpenseDraft {
    this.sweep();
    const members = session.members.filter((member) => member.removedAt === null);
    const payer = expense?.payerMemberId ?? members.find((member) => member.discordUserId === owner)?.id ?? members[0]?.id ?? "";
    const draft: ExpenseDraft = {
      token: newDraftToken(), owner, guild, sessionId: session.id, revision: session.revision,
      ...(expense ? { expenseId: expense.id } : {}), title: expense?.title ?? "", amount: expense ? String(expense.amount) : "",
      payer, eligible: new Set(expense?.eligibleMemberIds ?? members.map((member) => member.id)),
      allEligible: !expense, memberPage: 0, generation: 0, expiresAt: Date.now() + 15 * 60_000,
    };
    this.drafts.set(draft.token, draft);
    while (this.drafts.size > this.maxDrafts) {
      const oldest = this.drafts.keys().next().value;
      if (oldest === undefined) break;
      this.drafts.delete(oldest);
    }
    return draft;
  }

  get(token: string, owner: string, guild: string, sessionId: string, revision: number): ExpenseDraft | null {
    this.sweep();
    const draft = this.drafts.get(token);
    return draft && draft.owner === owner && draft.guild === guild && draft.sessionId === sessionId && draft.revision === revision ? draft : null;
  }

  delete(token: string): void { this.drafts.delete(token); }
  private sweep(): void { for (const [key, value] of this.drafts) if (value.expiresAt < Date.now()) this.drafts.delete(key); }
}

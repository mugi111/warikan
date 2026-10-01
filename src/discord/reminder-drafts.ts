import { newDraftToken } from "./custom-id.js";

export interface ReminderDraft {
  token: string; owner: string; guild: string; session: string; revision: number; settlementId: string;
  channelId: string; firstReminderText: string; generation: number; expiresAt: number;
}

export class ReminderDraftStore {
  private readonly drafts = new Map<string, ReminderDraft>();
  create(input: Omit<ReminderDraft, "token" | "generation" | "expiresAt">): ReminderDraft {
    this.sweep();
    while (this.drafts.size >= 500) this.drafts.delete(this.drafts.keys().next().value!);
    const draft: ReminderDraft = { ...input, token: newDraftToken(), generation: 0, expiresAt: Date.now() + 15 * 60_000 };
    this.drafts.set(draft.token, draft);
    return draft;
  }
  get(token: string, owner: string, guild: string, session: string, revision: number, settlementId: string): ReminderDraft | undefined {
    this.sweep();
    const draft = this.drafts.get(token);
    if (!draft || draft.owner !== owner || draft.guild !== guild || draft.session !== session || draft.revision !== revision || draft.settlementId !== settlementId) return undefined;
    return draft;
  }
  delete(token: string): void { this.drafts.delete(token); }
  private sweep(): void { for (const [token, draft] of this.drafts) if (draft.expiresAt <= Date.now()) this.drafts.delete(token); }
}

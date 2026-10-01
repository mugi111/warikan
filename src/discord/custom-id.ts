import { randomUUID } from "node:crypto";

const actions = new Set(["list", "page", "open", "create", "new", "members", "mpage", "add", "remove", "rmconfirm", "settings", "rename", "expenses", "epage", "expense", "draft", "payer", "target", "untarget", "all", "fields", "save", "cancel", "edit", "delete", "delconfirm", "preview", "ppage", "finalize", "settlement", "balances", "transfer", "paid", "unpaid", "invalidate", "invconfirm", "close", "closeconfirm", "reminder", "remedit", "remchannel", "remfields", "remsave", "remcancel", "remstop", "remsend"]);

export interface CustomId { action: string; sessionId: string; revision: number; arg: string }

export function makeCustomId(action: string, sessionId = "", revision = 0, arg = ""): string {
  const id = sessionId.replaceAll("-", "");
  const value = `wk1:${action}:${id}:${revision.toString(36)}:${arg}`;
  if (!actions.has(action) || value.length > 100) throw new Error("Invalid component identifier");
  return value;
}

export function parseCustomId(value: string): CustomId | null {
  const match = /^wk1:([a-z]+):([0-9a-f]{0,32}):([0-9a-z]+):([A-Za-z0-9_-]{0,40})$/.exec(value);
  if (!match || !actions.has(match[1]!)) return null;
  const revision = Number.parseInt(match[3]!, 36);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  let sessionId = match[2]!;
  if (sessionId && sessionId.length !== 32) return null;
  if (sessionId) sessionId = `${sessionId.slice(0, 8)}-${sessionId.slice(8, 12)}-${sessionId.slice(12, 16)}-${sessionId.slice(16, 20)}-${sessionId.slice(20)}`;
  return { action: match[1]!, sessionId, revision, arg: match[4]! };
}

export const newDraftToken = (): string => randomUUID().replaceAll("-", "").slice(0, 16);

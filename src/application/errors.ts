export type ApplicationErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "FORBIDDEN" | "SESSION_NOT_ACTIVE"
  | "REVISION_CONFLICT" | "MEMBER_NOT_FOUND" | "MEMBER_IN_USE"
  | "EMPTY_EXPENSE_MEMBERS" | "DUPLICATE_MEMBER" | "ADJUSTMENTS_NOT_ZERO"
  | "NEGATIVE_SHARE" | "AMOUNT_OVERFLOW" | "STORAGE_BUSY";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly context: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

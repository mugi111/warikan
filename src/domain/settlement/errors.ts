export type SettlementCalculationErrorCode =
  | "EMPTY_MEMBERS"
  | "INVALID_IDENTIFIER"
  | "DUPLICATE_MEMBER"
  | "DUPLICATE_EXPENSE"
  | "INVALID_WEIGHT"
  | "INVALID_ADJUSTMENT"
  | "INVALID_AMOUNT"
  | "EMPTY_ELIGIBLE_MEMBERS"
  | "DUPLICATE_ELIGIBLE_MEMBER"
  | "UNKNOWN_MEMBER"
  | "ADJUSTMENTS_NOT_ZERO"
  | "NEGATIVE_SHARE"
  | "AMOUNT_OVERFLOW"
  | "INVARIANT_VIOLATION";

export class SettlementCalculationError extends Error {
  constructor(
    public readonly code: SettlementCalculationErrorCode,
    message: string,
    public readonly context: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "SettlementCalculationError";
  }
}

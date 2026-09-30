export interface SettlementMember {
  id: string;
  weight: number;
  fixedAdjustment: number;
}

export interface SettlementExpense {
  id: string;
  amount: number;
  payerMemberId: string;
  eligibleMemberIds: string[];
}

export interface SettlementCalculationInput {
  members: SettlementMember[];
  expenses: SettlementExpense[];
}

export interface ExpenseShare {
  memberId: string;
  amount: number;
}

export interface ExpenseAllocation {
  expenseId: string;
  shares: ExpenseShare[];
}

export interface MemberBalance {
  memberId: string;
  baseAmount: number;
  fixedAdjustment: number;
  shareAmount: number;
  paidAmount: number;
  balance: number;
}

export interface SettlementTransfer {
  fromMemberId: string;
  toMemberId: string;
  amount: number;
}

export interface SettlementCalculation {
  totalAmount: number;
  expenseAllocations: ExpenseAllocation[];
  balances: MemberBalance[];
  transfers: SettlementTransfer[];
}

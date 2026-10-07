import { SettlementCalculationError } from "./errors.js";
import type {
  ExpenseAllocation,
  MemberBalance,
  SettlementCalculation,
  SettlementCalculationInput,
  SettlementExpense,
  SettlementMember,
  SettlementTransfer,
} from "./types.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function fail(
  code: ConstructorParameters<typeof SettlementCalculationError>[0],
  message: string,
  context: Readonly<Record<string, string | number>> = {},
): never {
  throw new SettlementCalculationError(code, message, context);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }

  return leftPoints.length - rightPoints.length;
}

function compareIds<T extends { id: string }>(left: T, right: T): number {
  return compareCodePoints(left.id, right.id);
}

function toSafeNumber(value: bigint, context: Readonly<Record<string, string | number>>): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    fail("AMOUNT_OVERFLOW", "A calculated amount exceeds the safe integer range.", context);
  }
  return Number(value);
}

interface ExactWeight {
  coefficient: bigint;
  exponent: number;
}

function parseWeight(weight: number, memberId: string): ExactWeight {
  if (!Number.isFinite(weight) || weight <= 0) {
    fail("INVALID_WEIGHT", "Member weights must be positive finite numbers.", { memberId, weight });
  }

  const [coefficientText, exponentText] = weight.toString().toLowerCase().split("e");
  const [whole = "", fraction = ""] = coefficientText!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  const exponent = Number(exponentText ?? 0) - fraction.length;

  return { coefficient: BigInt(digits), exponent };
}

function normalizeWeights(members: SettlementMember[]): Map<string, bigint> {
  const parsed = members.map((member) => ({ member, weight: parseWeight(member.weight, member.id) }));
  const minimumExponent = Math.min(...parsed.map(({ weight }) => weight.exponent));
  return new Map(parsed.map(({ member, weight }) => [
    member.id,
    weight.coefficient * 10n ** BigInt(weight.exponent - minimumExponent),
  ]));
}

function allocateExpense(
  expense: SettlementExpense,
  normalizedWeights: Map<string, bigint>,
): ExpenseAllocation {
  const eligible = expense.eligibleMemberIds.map((memberId) => ({
    memberId,
    weight: normalizedWeights.get(memberId)!,
  }));
  const totalWeight = eligible.reduce((sum, member) => sum + member.weight, 0n);
  const amount = BigInt(expense.amount);
  const apportioned = eligible.map((member) => {
    const numerator = amount * member.weight;
    return {
      memberId: member.memberId,
      amount: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  const allocated = apportioned.reduce((sum, share) => sum + share.amount, 0n);
  let remaining = amount - allocated;
  const remainderOrder = [...apportioned].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareCodePoints(left.memberId, right.memberId);
  });

  for (const share of remainderOrder) {
    if (remaining === 0n) break;
    share.amount += 1n;
    remaining -= 1n;
  }

  if (remaining !== 0n) {
    fail("INVARIANT_VIOLATION", "Largest remainder allocation did not conserve the expense.", {
      expenseId: expense.id,
    });
  }

  const shares = apportioned
    .sort((left, right) => compareCodePoints(left.memberId, right.memberId))
    .map((share) => ({
      memberId: share.memberId,
      amount: toSafeNumber(share.amount, { expenseId: expense.id, memberId: share.memberId }),
    }));

  const shareTotal = shares.reduce((sum, share) => sum + BigInt(share.amount), 0n);
  if (shareTotal !== amount) {
    fail("INVARIANT_VIOLATION", "Expense shares do not equal the expense amount.", {
      expenseId: expense.id,
    });
  }

  return { expenseId: expense.id, shares };
}

const MAX_EXACT_SETTLEMENT_MEMBERS = 16;

interface SettlementParticipant {
  memberId: string;
  balance: bigint;
}

function generateGreedyTransfers(participants: SettlementParticipant[]): SettlementTransfer[] {
  const debtors = participants
    .filter(({ balance }) => balance < 0n)
    .map(({ memberId, balance }) => ({ memberId, remaining: -balance }));
  const creditors = participants
    .filter(({ balance }) => balance > 0n)
    .map(({ memberId, balance }) => ({ memberId, remaining: balance }));
  const transfers: SettlementTransfer[] = [];

  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort((left, right) => compareCodePoints(left.memberId, right.memberId));
    creditors.sort((left, right) => compareCodePoints(left.memberId, right.memberId));
    const debtor = debtors[0]!;
    const creditor = creditors[0]!;
    const amount = debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining;
    if (debtor.memberId === creditor.memberId || amount <= 0n) {
      fail("INVARIANT_VIOLATION", "Settlement produced an invalid transfer.", { memberId: debtor.memberId });
    }

    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amount: toSafeNumber(amount, { fromMemberId: debtor.memberId, toMemberId: creditor.memberId }),
    });
    debtor.remaining -= amount;
    creditor.remaining -= amount;
    if (debtor.remaining === 0n) debtors.shift();
    if (creditor.remaining === 0n) creditors.shift();
  }

  if (debtors.length !== 0 || creditors.length !== 0) {
    fail("INVARIANT_VIOLATION", "Settlement did not clear all balances.");
  }
  return transfers;
}

function findMinimumTransferGroups(participants: SettlementParticipant[]): SettlementParticipant[][] {
  const count = participants.length;
  const fullMask = (1 << count) - 1;
  const subsetSums = new Array<bigint>(1 << count).fill(0n);
  for (let mask = 1; mask <= fullMask; mask += 1) {
    const bit = mask & -mask;
    const index = 31 - Math.clz32(bit);
    subsetSums[mask] = subsetSums[mask ^ bit]! + participants[index]!.balance;
  }

  const memo = new Map<number, number>([[0, 0]]);
  const choice = new Map<number, number>();
  const maximizeGroups = (mask: number): number => {
    const known = memo.get(mask);
    if (known !== undefined) return known;
    const firstBit = mask & -mask;
    let best = Number.NEGATIVE_INFINITY;
    for (let subset = mask; subset !== 0; subset = (subset - 1) & mask) {
      if ((subset & firstBit) === 0 || subsetSums[subset] !== 0n) continue;
      const candidate = 1 + maximizeGroups(mask ^ subset);
      if (candidate > best) {
        best = candidate;
        choice.set(mask, subset);
      }
    }
    if (best === Number.NEGATIVE_INFINITY) {
      fail("INVARIANT_VIOLATION", "No zero-sum grouping exists for balanced participants.");
    }
    memo.set(mask, best);
    return best;
  };

  maximizeGroups(fullMask);
  const groups: SettlementParticipant[][] = [];
  for (let mask = fullMask; mask !== 0;) {
    const subset = choice.get(mask);
    if (subset === undefined) fail("INVARIANT_VIOLATION", "Exact settlement grouping is incomplete.");
    groups.push(participants.filter((_, index) => (subset & (1 << index)) !== 0));
    mask ^= subset;
  }
  return groups;
}

function validateTransfers(
  participants: SettlementParticipant[],
  transfers: SettlementTransfer[],
): SettlementTransfer[] {
  const remainingByMember = new Map(participants.map(({ memberId, balance }) => [memberId, balance]));
  let transferTotal = 0n;
  for (const transfer of transfers) {
    const amount = BigInt(transfer.amount);
    if (amount <= 0n || !remainingByMember.has(transfer.fromMemberId) || !remainingByMember.has(transfer.toMemberId)) {
      fail("INVARIANT_VIOLATION", "Settlement contains an invalid transfer.", {
        fromMemberId: transfer.fromMemberId,
        toMemberId: transfer.toMemberId,
      });
    }
    remainingByMember.set(transfer.fromMemberId, remainingByMember.get(transfer.fromMemberId)! + amount);
    remainingByMember.set(transfer.toMemberId, remainingByMember.get(transfer.toMemberId)! - amount);
    transferTotal += amount;
  }
  if ([...remainingByMember.values()].some((balance) => balance !== 0n)) {
    fail("INVARIANT_VIOLATION", "Settlement transfers do not match participant balances.");
  }
  const balanceTotal = participants
    .filter(({ balance }) => balance > 0n)
    .reduce((sum, { balance }) => sum + balance, 0n);
  if (transferTotal !== balanceTotal) {
    fail("INVARIANT_VIOLATION", "Settlement transfer amounts do not conserve money.");
  }
  return transfers.sort((left, right) =>
    compareCodePoints(left.fromMemberId, right.fromMemberId)
    || compareCodePoints(left.toMemberId, right.toMemberId));
}

function generateTransfers(balances: MemberBalance[]): SettlementTransfer[] {
  const participants = balances
    .filter(({ balance }) => balance !== 0)
    .map(({ memberId, balance }) => ({ memberId, balance: BigInt(balance) }))
    .sort((left, right) => compareCodePoints(left.memberId, right.memberId));
  if (participants.reduce((sum, participant) => sum + participant.balance, 0n) !== 0n) {
    fail("INVARIANT_VIOLATION", "Participant balances must sum to zero.");
  }
  const groups = participants.length <= MAX_EXACT_SETTLEMENT_MEMBERS
    ? findMinimumTransferGroups(participants)
    : [participants];
  return validateTransfers(participants, groups.flatMap(generateGreedyTransfers));
}

function validateInput(input: SettlementCalculationInput): {
  members: SettlementMember[];
  expenses: SettlementExpense[];
  membersById: Map<string, SettlementMember>;
} {
  if (input.members.length === 0) {
    fail("EMPTY_MEMBERS", "A settlement requires at least one member.");
  }

  const membersById = new Map<string, SettlementMember>();
  for (const member of input.members) {
    if (member.id.trim().length === 0) {
      fail("INVALID_IDENTIFIER", "Member identifiers must not be blank.", { memberId: member.id });
    }
    if (membersById.has(member.id)) {
      fail("DUPLICATE_MEMBER", "Member identifiers must be unique.", { memberId: member.id });
    }
    if (!Number.isSafeInteger(member.fixedAdjustment)) {
      fail("INVALID_ADJUSTMENT", "Fixed adjustments must be safe integers.", {
        memberId: member.id,
        fixedAdjustment: member.fixedAdjustment,
      });
    }
    parseWeight(member.weight, member.id);
    membersById.set(member.id, member);
  }

  const expenseIds = new Set<string>();
  for (const expense of input.expenses) {
    if (expense.id.trim().length === 0 || expense.payerMemberId.trim().length === 0) {
      fail("INVALID_IDENTIFIER", "Expense and payer identifiers must not be blank.", {
        expenseId: expense.id,
        payerMemberId: expense.payerMemberId,
      });
    }
    if (expenseIds.has(expense.id)) {
      fail("DUPLICATE_EXPENSE", "Expense identifiers must be unique.", { expenseId: expense.id });
    }
    expenseIds.add(expense.id);
    if (!Number.isSafeInteger(expense.amount) || expense.amount <= 0) {
      fail("INVALID_AMOUNT", "Expense amounts must be positive safe integers.", {
        expenseId: expense.id,
        amount: expense.amount,
      });
    }
    if (expense.eligibleMemberIds.length === 0) {
      fail("EMPTY_ELIGIBLE_MEMBERS", "Each expense must have at least one eligible member.", {
        expenseId: expense.id,
      });
    }
    if (!membersById.has(expense.payerMemberId)) {
      fail("UNKNOWN_MEMBER", "The expense payer must be a known member.", {
        expenseId: expense.id,
        memberId: expense.payerMemberId,
      });
    }
    const eligibleIds = new Set<string>();
    for (const memberId of expense.eligibleMemberIds) {
      if (memberId.trim().length === 0) {
        fail("INVALID_IDENTIFIER", "Eligible member identifiers must not be blank.", {
          expenseId: expense.id,
          memberId,
        });
      }
      if (eligibleIds.has(memberId)) {
        fail("DUPLICATE_ELIGIBLE_MEMBER", "Eligible member identifiers must be unique per expense.", {
          expenseId: expense.id,
          memberId,
        });
      }
      eligibleIds.add(memberId);
      if (!membersById.has(memberId)) {
        fail("UNKNOWN_MEMBER", "Every eligible member must be known.", {
          expenseId: expense.id,
          memberId,
        });
      }
    }
  }

  const adjustmentTotal = input.members.reduce((sum, member) => sum + BigInt(member.fixedAdjustment), 0n);
  if (adjustmentTotal !== 0n) {
    fail("ADJUSTMENTS_NOT_ZERO", "Fixed adjustments must sum to zero.", {
      adjustmentTotal: adjustmentTotal.toString(),
    });
  }

  return { members: input.members, expenses: input.expenses, membersById };
}

export function calculateSettlement(input: SettlementCalculationInput): SettlementCalculation {
  const { members, expenses } = validateInput(input);
  const normalizedWeights = normalizeWeights(members);
  const baseByMember = new Map(members.map((member) => [member.id, 0n]));
  const paidByMember = new Map(members.map((member) => [member.id, 0n]));
  const expenseAllocations = [...expenses]
    .sort(compareIds)
    .map((expense) => allocateExpense(expense, normalizedWeights));
  let totalAmount = 0n;

  for (const expense of [...expenses].sort(compareIds)) {
    const amount = BigInt(expense.amount);
    totalAmount += amount;
    paidByMember.set(expense.payerMemberId, paidByMember.get(expense.payerMemberId)! + amount);
    if (totalAmount > MAX_SAFE_BIGINT) {
      fail("AMOUNT_OVERFLOW", "Total expenses exceed the safe integer range.", { expenseId: expense.id });
    }
  }

  for (const allocation of expenseAllocations) {
    for (const share of allocation.shares) {
      baseByMember.set(share.memberId, baseByMember.get(share.memberId)! + BigInt(share.amount));
    }
  }

  const balances = [...members]
    .sort(compareIds)
    .map((member): MemberBalance => {
      const baseAmount = baseByMember.get(member.id)!;
      const fixedAdjustment = BigInt(member.fixedAdjustment);
      const shareAmount = baseAmount + fixedAdjustment;
      const paidAmount = paidByMember.get(member.id)!;
      if (shareAmount < 0n) {
        fail("NEGATIVE_SHARE", "A member's adjusted share cannot be negative.", {
          memberId: member.id,
          shareAmount: shareAmount.toString(),
        });
      }
      return {
        memberId: member.id,
        baseAmount: toSafeNumber(baseAmount, { memberId: member.id }),
        fixedAdjustment: member.fixedAdjustment,
        shareAmount: toSafeNumber(shareAmount, { memberId: member.id }),
        paidAmount: toSafeNumber(paidAmount, { memberId: member.id }),
        balance: toSafeNumber(paidAmount - shareAmount, { memberId: member.id }),
      };
    });

  const sharesTotal = balances.reduce((sum, balance) => sum + BigInt(balance.shareAmount), 0n);
  const paidTotal = balances.reduce((sum, balance) => sum + BigInt(balance.paidAmount), 0n);
  const balanceTotal = balances.reduce((sum, balance) => sum + BigInt(balance.balance), 0n);
  if (sharesTotal !== totalAmount || paidTotal !== totalAmount || balanceTotal !== 0n) {
    fail("INVARIANT_VIOLATION", "Settlement totals do not conserve money.");
  }

  return {
    totalAmount: toSafeNumber(totalAmount, {}),
    expenseAllocations,
    balances,
    transfers: generateTransfers(balances),
  };
}

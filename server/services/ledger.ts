import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { ledgerEntries, ledgerEvents, walletBalances } from "../../drizzle/schema";
import type { AssetType, LedgerEffect } from "../domain/playRoutine";

type LedgerEventType = "EVALUATION" | "COUPON_REDEMPTION" | "ADJUSTMENT" | "MIGRATION" | "REVERSAL";

type PostLedgerInput = {
  childId: number;
  eventType: LedgerEventType;
  idempotencyKey: string;
  actorUserId: number;
  reasonCode: string;
  reasonText?: string;
  evaluationId?: number;
  reversalOfEventId?: number;
  effectiveAt: Date;
  ruleSnapshot?: Record<string, unknown>;
  effects: LedgerEffect[];
  enforceNonNegative?: boolean;
};

function getHeader(result: unknown) {
  return (Array.isArray(result) ? result[0] : result) as { insertId?: number; affectedRows?: number };
}

export async function postLedgerEvent(tx: any, input: PostLedgerInput) {
  const existing = await tx
    .select({ id: ledgerEvents.id })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing[0]) {
    return { eventId: existing[0].id, duplicate: true, entries: [] as Array<{ assetType: AssetType; amount: number; balanceAfter: number }> };
  }

  const eventResult = await tx.insert(ledgerEvents).values({
    childId: input.childId,
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actorUserId,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText,
    evaluationId: input.evaluationId,
    reversalOfEventId: input.reversalOfEventId,
    effectiveAt: input.effectiveAt,
    ruleSnapshot: input.ruleSnapshot,
  });
  const eventId = Number(getHeader(eventResult).insertId);
  if (!eventId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "원장 사건을 생성하지 못했습니다." });

  const postedEntries: Array<{ assetType: AssetType; amount: number; balanceAfter: number }> = [];
  for (const effect of input.effects) {
    if (!Number.isInteger(effect.amount) || effect.amount === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "원장 변동량은 0이 아닌 정수여야 합니다." });
    }

    await tx
      .insert(walletBalances)
      .values({ childId: input.childId, assetType: effect.assetType, balance: 0, lastSequenceNo: 0 })
      .onDuplicateKeyUpdate({ set: { balance: sql`${walletBalances.balance}` } });

    const balanceGuard = input.enforceNonNegative && effect.amount < 0
      ? sql`${walletBalances.balance} + ${effect.amount} >= 0`
      : sql`TRUE`;
    const updateResult = await tx
      .update(walletBalances)
      .set({
        balance: sql`${walletBalances.balance} + ${effect.amount}`,
        lastSequenceNo: sql`${walletBalances.lastSequenceNo} + 1`,
      })
      .where(and(
        eq(walletBalances.childId, input.childId),
        eq(walletBalances.assetType, effect.assetType),
        balanceGuard,
      ));

    if (Number(getHeader(updateResult).affectedRows ?? 0) !== 1) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "사용 가능한 잔액이 부족합니다." });
    }

    const wallet = await tx
      .select({ balance: walletBalances.balance, sequenceNo: walletBalances.lastSequenceNo })
      .from(walletBalances)
      .where(and(eq(walletBalances.childId, input.childId), eq(walletBalances.assetType, effect.assetType)))
      .limit(1);
    if (!wallet[0]) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "잔액 갱신 결과를 확인할 수 없습니다." });

    await tx.insert(ledgerEntries).values({
      eventId,
      childId: input.childId,
      assetType: effect.assetType,
      amount: effect.amount,
      balanceAfter: wallet[0].balance,
      sequenceNo: wallet[0].sequenceNo,
    });
    postedEntries.push({ assetType: effect.assetType, amount: effect.amount, balanceAfter: wallet[0].balance });
  }

  return { eventId, duplicate: false, entries: postedEntries };
}

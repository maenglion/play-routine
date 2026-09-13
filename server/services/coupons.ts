import { and, asc, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  couponIssues,
  couponRedemptions,
  couponStateTransitions,
  couponTemplates,
  familyMemberships,
  guardianChildPermissions,
  ledgerEntries,
  ledgerEvents,
  notifications,
} from "../../drizzle/schema";
import { assertCouponTransition } from "../domain/playRoutine";
import { getDb } from "../db";
import { requireChildCapability } from "./access";
import { postLedgerEvent } from "./ledger";

function resultHeader(result: unknown) {
  return (Array.isArray(result) ? result[0] : result) as { insertId?: number; affectedRows?: number };
}

async function createCouponNotification(tx: any, input: {
  childId: number;
  title: string;
  body: string;
  ledgerEventId?: number;
}) {
  const recipients = await tx
    .select({ userId: familyMemberships.userId })
    .from(guardianChildPermissions)
    .innerJoin(familyMemberships, eq(familyMemberships.id, guardianChildPermissions.membershipId))
    .where(and(
      eq(guardianChildPermissions.childId, input.childId),
      eq(guardianChildPermissions.canReceiveNotifications, true),
      eq(familyMemberships.status, "ACTIVE"),
    ));
  if (recipients.length === 0) return;
  await tx.insert(notifications).values(recipients.map((recipient: { userId: number }) => ({
    recipientUserId: recipient.userId,
    childId: input.childId,
    notificationType: "COUPON" as const,
    title: input.title,
    body: input.body,
    ledgerEventId: input.ledgerEventId,
  })));
}

export async function createCouponTemplate(input: {
  userId: number;
  childId: number;
  code: string;
  title: string;
  minutes: number;
}) {
  const access = await requireChildCapability(input.userId, input.childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const result = await db.insert(couponTemplates).values({
    familyId: access.familyId,
    code: input.code,
    title: input.title,
    assetType: "TIME_MINUTE",
    redemptionAmount: -Math.abs(input.minutes),
  });
  return { id: Number(resultHeader(result).insertId ?? 0) };
}

export async function issueCoupon(input: {
  userId: number;
  childId: number;
  templateId: number;
  serialCode: string;
  assignNow: boolean;
  expiresAt?: Date;
}) {
  const access = await requireChildCapability(input.userId, input.childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const template = await db
    .select({ id: couponTemplates.id })
    .from(couponTemplates)
    .where(and(eq(couponTemplates.id, input.templateId), eq(couponTemplates.familyId, access.familyId), eq(couponTemplates.status, "ACTIVE")))
    .limit(1);
  if (!template[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "사용할 수 없는 쿠폰 유형입니다." });

  return db.transaction(async tx => {
    const toStatus = input.assignNow ? "ASSIGNED" as const : "ISSUED" as const;
    const result = await tx.insert(couponIssues).values({
      couponTemplateId: input.templateId,
      serialCode: input.serialCode,
      childId: input.assignNow ? input.childId : undefined,
      status: toStatus,
      issuedByUserId: input.userId,
      assignedByUserId: input.assignNow ? input.userId : undefined,
      assignedAt: input.assignNow ? new Date() : undefined,
      expiresAt: input.expiresAt,
    });
    const couponIssueId = Number(resultHeader(result).insertId ?? 0);
    await tx.insert(couponStateTransitions).values({
      couponIssueId,
      fromStatus: null,
      toStatus,
      actorUserId: input.userId,
      reason: input.assignNow ? "발행 즉시 자녀에게 할당" : "실물 쿠폰 발행",
    });
    return { couponIssueId, status: toStatus };
  });
}

export async function assignCoupon(userId: number, childId: number, couponIssueId: number) {
  const access = await requireChildCapability(userId, childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const rows = await db
    .select({ id: couponIssues.id, status: couponIssues.status, familyId: couponTemplates.familyId })
    .from(couponIssues)
    .innerJoin(couponTemplates, eq(couponTemplates.id, couponIssues.couponTemplateId))
    .where(eq(couponIssues.id, couponIssueId))
    .limit(1);
  const coupon = rows[0];
  if (!coupon || coupon.familyId !== access.familyId) throw new TRPCError({ code: "NOT_FOUND", message: "쿠폰을 찾을 수 없습니다." });
  assertCouponTransition(coupon.status, "ASSIGNED");

  return db.transaction(async tx => {
    const update = await tx
      .update(couponIssues)
      .set({ childId, status: "ASSIGNED", assignedByUserId: userId, assignedAt: new Date() })
      .where(and(eq(couponIssues.id, couponIssueId), eq(couponIssues.status, "ISSUED")));
    if (Number(resultHeader(update).affectedRows ?? 0) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "쿠폰 상태가 이미 변경되었습니다." });
    }
    await tx.insert(couponStateTransitions).values({
      couponIssueId,
      fromStatus: "ISSUED",
      toStatus: "ASSIGNED",
      actorUserId: userId,
      reason: "자녀에게 실물 쿠폰 할당",
    });
    return { couponIssueId, status: "ASSIGNED" as const };
  });
}

export async function redeemCoupon(input: {
  userId: number;
  childId: number;
  couponIssueId: number;
  idempotencyKey: string;
}) {
  await requireChildCapability(input.userId, input.childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const duplicate = await db.select({ id: ledgerEvents.id }).from(ledgerEvents).where(eq(ledgerEvents.idempotencyKey, input.idempotencyKey)).limit(1);
  if (duplicate[0]) return { duplicate: true, ledgerEventId: duplicate[0].id };

  const rows = await db
    .select({
      id: couponIssues.id,
      childId: couponIssues.childId,
      status: couponIssues.status,
      serialCode: couponIssues.serialCode,
      expiresAt: couponIssues.expiresAt,
      title: couponTemplates.title,
      assetType: couponTemplates.assetType,
      amount: couponTemplates.redemptionAmount,
    })
    .from(couponIssues)
    .innerJoin(couponTemplates, eq(couponTemplates.id, couponIssues.couponTemplateId))
    .where(eq(couponIssues.id, input.couponIssueId))
    .limit(1);
  const coupon = rows[0];
  if (!coupon || coupon.childId !== input.childId) throw new TRPCError({ code: "NOT_FOUND", message: "이 자녀에게 할당된 쿠폰이 아닙니다." });
  assertCouponTransition(coupon.status, "REDEEMED");
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "만료된 쿠폰입니다." });
  }

  return db.transaction(async tx => {
    const ledger = await postLedgerEvent(tx, {
      childId: input.childId,
      eventType: "COUPON_REDEMPTION",
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.userId,
      reasonCode: "PHYSICAL_COUPON_REDEEMED",
      reasonText: `${coupon.title} · ${coupon.serialCode}`,
      effectiveAt: new Date(),
      effects: [{ assetType: coupon.assetType, amount: coupon.amount }],
      enforceNonNegative: true,
    });

    const update = await tx
      .update(couponIssues)
      .set({ status: "REDEEMED" })
      .where(and(eq(couponIssues.id, input.couponIssueId), eq(couponIssues.status, "ASSIGNED"), eq(couponIssues.childId, input.childId)));
    if (Number(resultHeader(update).affectedRows ?? 0) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "이미 사용되었거나 상태가 변경된 쿠폰입니다." });
    }
    await tx.insert(couponRedemptions).values({
      couponIssueId: input.couponIssueId,
      childId: input.childId,
      ledgerEventId: ledger.eventId,
      redeemedByUserId: input.userId,
    });
    await tx.insert(couponStateTransitions).values({
      couponIssueId: input.couponIssueId,
      fromStatus: "ASSIGNED",
      toStatus: "REDEEMED",
      actorUserId: input.userId,
      reason: "실물 쿠폰 사용 승인",
    });
    await createCouponNotification(tx, {
      childId: input.childId,
      title: `${coupon.title} 사용`,
      body: `${Math.abs(coupon.amount)}분 쿠폰이 사용되었습니다.`,
      ledgerEventId: ledger.eventId,
    });
    return { duplicate: false, ledgerEventId: ledger.eventId, entries: ledger.entries };
  });
}

export async function cancelCoupon(input: {
  userId: number;
  childId: number;
  couponIssueId: number;
  reason: string;
}) {
  await requireChildCapability(input.userId, input.childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const rows = await db.select().from(couponIssues).where(eq(couponIssues.id, input.couponIssueId)).limit(1);
  const coupon = rows[0];
  if (!coupon || (coupon.childId != null && coupon.childId !== input.childId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "쿠폰을 찾을 수 없습니다." });
  }
  assertCouponTransition(coupon.status, "CANCELLED");

  const redemptionRows = await db
    .select()
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponIssueId, input.couponIssueId))
    .limit(1);
  const redemption = redemptionRows[0];

  return db.transaction(async tx => {
    let reversalEventId: number | null = null;
    if (coupon.status === "REDEEMED" && redemption) {
      const entries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.eventId, redemption.ledgerEventId));
      const reversal = await postLedgerEvent(tx, {
        childId: input.childId,
        eventType: "REVERSAL",
        idempotencyKey: `coupon-reversal:${redemption.id}`,
        actorUserId: input.userId,
        reasonCode: "COUPON_REDEMPTION_REVERSED",
        reasonText: input.reason,
        reversalOfEventId: redemption.ledgerEventId,
        effectiveAt: new Date(),
        effects: entries.map(entry => ({ assetType: entry.assetType, amount: -entry.amount })),
      });
      reversalEventId = reversal.eventId;
      await tx.update(couponRedemptions).set({ status: "REVERSED", reversedAt: new Date(), reversalReason: input.reason }).where(eq(couponRedemptions.id, redemption.id));
    }
    const update = await tx.update(couponIssues).set({ status: "CANCELLED" }).where(and(eq(couponIssues.id, input.couponIssueId), eq(couponIssues.status, coupon.status)));
    if (Number(resultHeader(update).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "쿠폰 상태가 이미 변경되었습니다." });
    await tx.insert(couponStateTransitions).values({
      couponIssueId: input.couponIssueId,
      fromStatus: coupon.status,
      toStatus: "CANCELLED",
      actorUserId: input.userId,
      reason: input.reason,
    });
    await createCouponNotification(tx, {
      childId: input.childId,
      title: "쿠폰 사용 취소",
      body: redemption ? "쿠폰 차감이 원장 취소 거래로 복원되었습니다." : "미사용 쿠폰이 취소되었습니다.",
      ledgerEventId: reversalEventId ?? undefined,
    });
    return { couponIssueId: input.couponIssueId, status: "CANCELLED" as const, reversalEventId };
  });
}

export async function expireCoupon(input: {
  userId: number;
  childId: number;
  couponIssueId: number;
  reason: string;
}) {
  await requireChildCapability(input.userId, input.childId, "manageCoupons");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const rows = await db.select().from(couponIssues).where(eq(couponIssues.id, input.couponIssueId)).limit(1);
  const coupon = rows[0];
  if (!coupon || (coupon.childId != null && coupon.childId !== input.childId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "쿠폰을 찾을 수 없습니다." });
  }
  assertCouponTransition(coupon.status, "EXPIRED");

  return db.transaction(async tx => {
    const update = await tx
      .update(couponIssues)
      .set({ status: "EXPIRED" })
      .where(and(eq(couponIssues.id, input.couponIssueId), eq(couponIssues.status, coupon.status)));
    if (Number(resultHeader(update).affectedRows ?? 0) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "쿠폰 상태가 이미 변경되었습니다." });
    }
    await tx.insert(couponStateTransitions).values({
      couponIssueId: input.couponIssueId,
      fromStatus: coupon.status,
      toStatus: "EXPIRED",
      actorUserId: input.userId,
      reason: input.reason,
    });
    await createCouponNotification(tx, {
      childId: input.childId,
      title: "쿠폰 만료",
      body: `${coupon.serialCode} 쿠폰이 만료 처리되었습니다.`,
    });
    return { couponIssueId: input.couponIssueId, status: "EXPIRED" as const };
  });
}

export async function listCoupons(userId: number, childId: number) {
  const access = await requireChildCapability(userId, childId, "view");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const templates = await db
    .select()
    .from(couponTemplates)
    .where(and(eq(couponTemplates.familyId, access.familyId), eq(couponTemplates.status, "ACTIVE")))
    .orderBy(asc(couponTemplates.redemptionAmount));
  const issues = await db
    .select({
      id: couponIssues.id,
      serialCode: couponIssues.serialCode,
      status: couponIssues.status,
      childId: couponIssues.childId,
      title: couponTemplates.title,
      amount: couponTemplates.redemptionAmount,
      issuedAt: couponIssues.issuedAt,
      assignedAt: couponIssues.assignedAt,
      expiresAt: couponIssues.expiresAt,
    })
    .from(couponIssues)
    .innerJoin(couponTemplates, eq(couponTemplates.id, couponIssues.couponTemplateId))
    .where(and(eq(couponTemplates.familyId, access.familyId), eq(couponIssues.childId, childId)))
    .orderBy(desc(couponIssues.issuedAt));
  return { templates, issues };
}

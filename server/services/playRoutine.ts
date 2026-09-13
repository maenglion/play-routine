import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import {
  activityAssignments,
  activityRubrics,
  activityTemplates,
  children,
  evaluations,
  families,
  familyMemberships,
  guardianChildPermissions,
  ledgerEntries,
  ledgerEvents,
  notifications,
  rubrics,
  rubricLevels,
  rubricVersions,
  ruleEffects,
  walletBalances,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { validateEffectsForOutcome, validateEvaluationSelection } from "../domain/playRoutine";
import { requireChildCapability } from "./access";
import { postLedgerEvent } from "./ledger";

function insertId(result: unknown) {
  const header = (Array.isArray(result) ? result[0] : result) as { insertId?: number };
  return Number(header?.insertId ?? 0);
}

export async function listWorkspace(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const rows = await db
    .select({
      familyId: families.id,
      familyName: families.name,
      membershipRole: familyMemberships.role,
      childId: children.id,
      childName: children.displayName,
      childStatus: children.status,
      canView: guardianChildPermissions.canView,
      canEvaluate: guardianChildPermissions.canEvaluate,
      canManageRules: guardianChildPermissions.canManageRules,
      canManageCoupons: guardianChildPermissions.canManageCoupons,
    })
    .from(familyMemberships)
    .innerJoin(families, eq(families.id, familyMemberships.familyId))
    .innerJoin(guardianChildPermissions, eq(guardianChildPermissions.membershipId, familyMemberships.id))
    .innerJoin(children, eq(children.id, guardianChildPermissions.childId))
    .where(and(eq(familyMemberships.userId, userId), eq(familyMemberships.status, "ACTIVE"), eq(guardianChildPermissions.canView, true)))
    .orderBy(asc(families.name), asc(children.displayName));

  return rows;
}

export async function bootstrapWorkspace(userId: number, familyName: string, childName: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const existing = await listWorkspace(userId);
  if (existing.length > 0) return existing[0];

  await db.transaction(async tx => {
    const familyResult = await tx.insert(families).values({ name: familyName, ownerUserId: userId });
    const familyId = insertId(familyResult);
    const membershipResult = await tx.insert(familyMemberships).values({
      familyId,
      userId,
      role: "OWNER",
      status: "ACTIVE",
      joinedAt: new Date(),
    });
    const membershipId = insertId(membershipResult);
    const childResult = await tx.insert(children).values({ familyId, displayName: childName });
    const childId = insertId(childResult);
    await tx.insert(guardianChildPermissions).values({
      membershipId,
      childId,
      canView: true,
      canEvaluate: true,
      canManageRules: true,
      canManageCoupons: true,
      canReceiveNotifications: true,
      grantedByUserId: userId,
    });
    await tx.insert(walletBalances).values([
      { childId, assetType: "TIME_MINUTE", balance: 0, lastSequenceNo: 0 },
      { childId, assetType: "MONEY_KRW", balance: 0, lastSequenceNo: 0 },
    ]);
  });

  const created = await listWorkspace(userId);
  if (!created[0]) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "가족 공간을 생성하지 못했습니다." });
  return created[0];
}

export async function createThreeLevelRubric(input: {
  userId: number;
  childId: number;
  activityTitle: string;
  rubricTitle: string;
  rewardMinutes: number;
  penaltyMinutes: number;
}) {
  const access = await requireChildCapability(input.userId, input.childId, "manageRules");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const suffix = nanoid(8).toUpperCase();

  return db.transaction(async tx => {
    const activityResult = await tx.insert(activityTemplates).values({
      familyId: access.familyId,
      code: `ACT_${suffix}`,
      title: input.activityTitle,
      status: "ACTIVE",
    });
    const activityTemplateId = insertId(activityResult);
    const rubricResult = await tx.insert(rubrics).values({
      familyId: access.familyId,
      code: `RUBRIC_${suffix}`,
      title: input.rubricTitle,
      description: "보상·중립·패널티를 명시적으로 구분하는 3단계 루브릭",
    });
    const rubricId = insertId(rubricResult);
    const versionResult = await tx.insert(rubricVersions).values({
      rubricId,
      versionNo: 1,
      status: "PUBLISHED",
      validFrom: new Date().toISOString().slice(0, 10),
      createdByUserId: input.userId,
      publishedAt: new Date(),
    });
    const rubricVersionId = insertId(versionResult);

    const levelRows = [
      { code: "REWARD", label: "충분히 잘했어요", outcomeType: "REWARD" as const, sortOrder: 1 },
      { code: "NEUTRAL", label: "점수 변화 없음", outcomeType: "NEUTRAL" as const, sortOrder: 2 },
      { code: "PENALTY", label: "약속한 기준 미달", outcomeType: "PENALTY" as const, sortOrder: 3 },
    ];
    const levelIds: Record<string, number> = {};
    for (const level of levelRows) {
      const result = await tx.insert(rubricLevels).values({ rubricVersionId, ...level });
      levelIds[level.code] = insertId(result);
    }

    await tx.insert(ruleEffects).values([
      { rubricLevelId: levelIds.REWARD, assetType: "TIME_MINUTE", amount: input.rewardMinutes },
      { rubricLevelId: levelIds.PENALTY, assetType: "TIME_MINUTE", amount: -input.penaltyMinutes },
    ]);
    await tx.insert(activityRubrics).values({ activityTemplateId, rubricId, isRequired: true });

    return { activityTemplateId, rubricId, rubricVersionId };
  });
}

export async function listRubricCatalog(userId: number, childId: number) {
  const access = await requireChildCapability(userId, childId, "view");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const rows = await db
    .select({
      activityTemplateId: activityTemplates.id,
      activityTitle: activityTemplates.title,
      rubricId: rubrics.id,
      rubricTitle: rubrics.title,
      rubricVersionId: rubricVersions.id,
      levelId: rubricLevels.id,
      levelCode: rubricLevels.code,
      levelLabel: rubricLevels.label,
      outcomeType: rubricLevels.outcomeType,
      assetType: ruleEffects.assetType,
      amount: ruleEffects.amount,
    })
    .from(activityRubrics)
    .innerJoin(activityTemplates, eq(activityTemplates.id, activityRubrics.activityTemplateId))
    .innerJoin(rubrics, eq(rubrics.id, activityRubrics.rubricId))
    .innerJoin(rubricVersions, and(eq(rubricVersions.rubricId, rubrics.id), eq(rubricVersions.status, "PUBLISHED")))
    .innerJoin(rubricLevels, eq(rubricLevels.rubricVersionId, rubricVersions.id))
    .leftJoin(ruleEffects, eq(ruleEffects.rubricLevelId, rubricLevels.id))
    .where(and(eq(activityTemplates.familyId, access.familyId), eq(activityTemplates.status, "ACTIVE")))
    .orderBy(asc(activityTemplates.title), asc(rubricLevels.sortOrder));

  const grouped = new Map<number, {
    activityTemplateId: number;
    activityTitle: string;
    rubricId: number;
    rubricTitle: string;
    rubricVersionId: number;
    levels: Array<{ id: number; code: string; label: string; outcomeType: string; effects: Array<{ assetType: string; amount: number }> }>;
  }>();
  for (const row of rows) {
    if (!grouped.has(row.rubricVersionId)) {
      grouped.set(row.rubricVersionId, {
        activityTemplateId: row.activityTemplateId,
        activityTitle: row.activityTitle,
        rubricId: row.rubricId,
        rubricTitle: row.rubricTitle,
        rubricVersionId: row.rubricVersionId,
        levels: [],
      });
    }
    const item = grouped.get(row.rubricVersionId)!;
    let level = item.levels.find(entry => entry.id === row.levelId);
    if (!level) {
      level = { id: row.levelId, code: row.levelCode, label: row.levelLabel, outcomeType: row.outcomeType, effects: [] };
      item.levels.push(level);
    }
    if (row.assetType && row.amount) level.effects.push({ assetType: row.assetType, amount: row.amount });
  }
  return Array.from(grouped.values());
}

export async function createAssignment(input: {
  userId: number;
  childId: number;
  activityTemplateId: number;
  scheduledDate: string;
  note?: string;
}) {
  await requireChildCapability(input.userId, input.childId, "evaluate");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const result = await db.insert(activityAssignments).values({
    childId: input.childId,
    activityTemplateId: input.activityTemplateId,
    scheduledDate: input.scheduledDate,
    note: input.note,
    isRequired: true,
    createdByUserId: input.userId,
  });
  return { id: insertId(result) };
}

export async function submitEvaluation(input: {
  userId: number;
  childId: number;
  assignmentId: number;
  rubricVersionId: number;
  rubricLevelId?: number;
  applicability: "APPLICABLE" | "NOT_APPLICABLE";
  note?: string;
  idempotencyKey: string;
}) {
  validateEvaluationSelection(input);
  await requireChildCapability(input.userId, input.childId, "evaluate");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const assignment = await db
    .select({ childId: activityAssignments.childId, activityTemplateId: activityAssignments.activityTemplateId, activityTitle: activityTemplates.title })
    .from(activityAssignments)
    .innerJoin(activityTemplates, eq(activityTemplates.id, activityAssignments.activityTemplateId))
    .where(and(eq(activityAssignments.id, input.assignmentId), eq(activityAssignments.childId, input.childId)))
    .limit(1);
  if (!assignment[0]) throw new TRPCError({ code: "NOT_FOUND", message: "평가할 활동 배정을 찾을 수 없습니다." });

  const duplicateEvaluation = await db
    .select({ id: evaluations.id, status: evaluations.status })
    .from(evaluations)
    .where(eq(evaluations.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (duplicateEvaluation[0]) {
    return { evaluationId: duplicateEvaluation[0].id, outcomeType: "DUPLICATE" as const, ledger: null };
  }

  const versionLink = await db
    .select({ rubricId: rubricVersions.rubricId, rubricTitle: rubrics.title })
    .from(rubricVersions)
    .innerJoin(rubrics, eq(rubrics.id, rubricVersions.rubricId))
    .innerJoin(activityRubrics, and(eq(activityRubrics.rubricId, rubrics.id), eq(activityRubrics.activityTemplateId, assignment[0].activityTemplateId)))
    .where(and(eq(rubricVersions.id, input.rubricVersionId), eq(rubricVersions.status, "PUBLISHED")))
    .limit(1);
  if (!versionLink[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "이 활동에 게시된 루브릭이 아닙니다." });

  let level: { id: number; label: string; outcomeType: "REWARD" | "NEUTRAL" | "PENALTY" } | undefined;
  let effects: Array<{ assetType: "TIME_MINUTE" | "MONEY_KRW"; amount: number }> = [];
  if (input.applicability === "APPLICABLE") {
    const levelRows = await db
      .select({ id: rubricLevels.id, label: rubricLevels.label, outcomeType: rubricLevels.outcomeType })
      .from(rubricLevels)
      .where(and(eq(rubricLevels.id, input.rubricLevelId!), eq(rubricLevels.rubricVersionId, input.rubricVersionId)))
      .limit(1);
    level = levelRows[0];
    if (!level) throw new TRPCError({ code: "BAD_REQUEST", message: "선택한 루브릭 수준이 올바르지 않습니다." });
    effects = await db
      .select({ assetType: ruleEffects.assetType, amount: ruleEffects.amount })
      .from(ruleEffects)
      .where(eq(ruleEffects.rubricLevelId, level.id));
    validateEffectsForOutcome(level.outcomeType, effects);
  }

  return db.transaction(async tx => {
    const evaluationResult = await tx.insert(evaluations).values({
      idempotencyKey: input.idempotencyKey,
      childId: input.childId,
      assignmentId: input.assignmentId,
      rubricVersionId: input.rubricVersionId,
      rubricLevelId: input.rubricLevelId,
      applicability: input.applicability,
      status: "SUBMITTED",
      note: input.note,
      evaluatorUserId: input.userId,
      evaluatedAt: new Date(),
    });
    const evaluationId = insertId(evaluationResult);

    let ledgerResult: Awaited<ReturnType<typeof postLedgerEvent>> | null = null;
    if (level && level.outcomeType !== "NEUTRAL") {
      ledgerResult = await postLedgerEvent(tx, {
        childId: input.childId,
        eventType: "EVALUATION",
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.userId,
        reasonCode: `RUBRIC_${level.outcomeType}`,
        reasonText: `${assignment[0].activityTitle} · ${level.label}`,
        evaluationId,
        effectiveAt: new Date(),
        ruleSnapshot: {
          rubricVersionId: input.rubricVersionId,
          rubricTitle: versionLink[0].rubricTitle,
          levelId: level.id,
          levelLabel: level.label,
          outcomeType: level.outcomeType,
          effects,
        },
        effects,
      });
    }

    await tx.update(activityAssignments).set({ status: "COMPLETED" }).where(eq(activityAssignments.id, input.assignmentId));

    const recipients = await tx
      .select({ userId: familyMemberships.userId })
      .from(guardianChildPermissions)
      .innerJoin(familyMemberships, eq(familyMemberships.id, guardianChildPermissions.membershipId))
      .where(and(
        eq(guardianChildPermissions.childId, input.childId),
        eq(guardianChildPermissions.canReceiveNotifications, true),
        eq(familyMemberships.status, "ACTIVE"),
      ));
    if (recipients.length > 0) {
      await tx.insert(notifications).values(recipients.map(recipient => ({
        recipientUserId: recipient.userId,
        childId: input.childId,
        notificationType: level?.outcomeType === "PENALTY" ? "PENALTY" as const : "EVALUATION" as const,
        title: `${assignment[0].activityTitle} 평가 완료`,
        body: input.applicability === "NOT_APPLICABLE" ? "오늘은 해당 없음으로 기록되었습니다." : `${level?.label ?? "평가"}로 기록되었습니다.`,
        evaluationId,
        ledgerEventId: ledgerResult?.eventId,
      })));
    }

    return { evaluationId, outcomeType: level?.outcomeType ?? "NOT_APPLICABLE", ledger: ledgerResult };
  });
}

export async function reverseEvaluation(userId: number, evaluationId: number, reason: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const evaluationRows = await db.select().from(evaluations).where(eq(evaluations.id, evaluationId)).limit(1);
  const evaluation = evaluationRows[0];
  if (!evaluation) throw new TRPCError({ code: "NOT_FOUND", message: "평가 기록을 찾을 수 없습니다." });
  await requireChildCapability(userId, evaluation.childId, "evaluate");
  if (evaluation.status === "REVERSED") throw new TRPCError({ code: "CONFLICT", message: "이미 취소된 평가입니다." });

  const eventRows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.evaluationId, evaluationId)).limit(1);
  const originalEvent = eventRows[0];
  const originalEntries = originalEvent
    ? await db.select().from(ledgerEntries).where(eq(ledgerEntries.eventId, originalEvent.id))
    : [];

  return db.transaction(async tx => {
    let reversalEventId: number | null = null;
    if (originalEvent && originalEntries.length > 0) {
      const result = await postLedgerEvent(tx, {
        childId: evaluation.childId,
        eventType: "REVERSAL",
        idempotencyKey: `evaluation-reversal:${evaluationId}`,
        actorUserId: userId,
        reasonCode: "EVALUATION_REVERSED",
        reasonText: reason,
        reversalOfEventId: originalEvent.id,
        effectiveAt: new Date(),
        effects: originalEntries.map(entry => ({ assetType: entry.assetType, amount: -entry.amount })),
      });
      reversalEventId = result.eventId;
    }
    await tx.update(evaluations).set({ status: "REVERSED", reversedAt: new Date(), reversalReason: reason }).where(eq(evaluations.id, evaluationId));
    if (evaluation.assignmentId) {
      await tx.update(activityAssignments).set({ status: "SCHEDULED" }).where(eq(activityAssignments.id, evaluation.assignmentId));
    }
    return { evaluationId, reversalEventId };
  });
}

export async function getChildDashboard(userId: number, childId: number) {
  await requireChildCapability(userId, childId, "view");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });
  const balances = await db.select().from(walletBalances).where(eq(walletBalances.childId, childId));
  const upcoming = await db
    .select({
      id: activityAssignments.id,
      date: activityAssignments.scheduledDate,
      status: activityAssignments.status,
      title: activityTemplates.title,
      activityTemplateId: activityTemplates.id,
    })
    .from(activityAssignments)
    .innerJoin(activityTemplates, eq(activityTemplates.id, activityAssignments.activityTemplateId))
    .where(eq(activityAssignments.childId, childId))
    .orderBy(desc(activityAssignments.scheduledDate))
    .limit(12);
  const recentLedger = await db
    .select({
      eventId: ledgerEvents.id,
      eventType: ledgerEvents.eventType,
      reasonCode: ledgerEvents.reasonCode,
      reasonText: ledgerEvents.reasonText,
      effectiveAt: ledgerEvents.effectiveAt,
      assetType: ledgerEntries.assetType,
      amount: ledgerEntries.amount,
      balanceAfter: ledgerEntries.balanceAfter,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerEvents, eq(ledgerEvents.id, ledgerEntries.eventId))
    .where(eq(ledgerEntries.childId, childId))
    .orderBy(desc(ledgerEntries.id))
    .limit(20);
  const inbox = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), eq(notifications.childId, childId)))
    .orderBy(desc(notifications.createdAt))
    .limit(8);
  return { balances, upcoming, recentLedger, notifications: inbox };
}

export async function reconcileChildLedger(userId: number, childId: number) {
  await requireChildCapability(userId, childId, "view");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const cached = await db
    .select({ assetType: walletBalances.assetType, balance: walletBalances.balance })
    .from(walletBalances)
    .where(eq(walletBalances.childId, childId));
  const summed = await db
    .select({
      assetType: ledgerEntries.assetType,
      ledgerTotal: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.childId, childId))
    .groupBy(ledgerEntries.assetType);

  const assetTypes = ["TIME_MINUTE", "MONEY_KRW"] as const;
  const assets = assetTypes.map(assetType => {
    const cachedBalance = cached.find(row => row.assetType === assetType)?.balance ?? 0;
    const ledgerTotal = Number(summed.find(row => row.assetType === assetType)?.ledgerTotal ?? 0);
    return {
      assetType,
      cachedBalance,
      ledgerTotal,
      difference: cachedBalance - ledgerTotal,
      consistent: cachedBalance === ledgerTotal,
    };
  });
  return { childId, consistent: assets.every(asset => asset.consistent), assets };
}

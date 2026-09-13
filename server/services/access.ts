import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  children,
  familyMemberships,
  guardianChildPermissions,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { type ChildCapability, hasCapability } from "../domain/playRoutine";

export async function requireChildCapability(
  userId: number,
  childId: number,
  capability: ChildCapability,
) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "데이터베이스에 연결할 수 없습니다." });

  const rows = await db
    .select({
      childId: children.id,
      childName: children.displayName,
      familyId: children.familyId,
      role: familyMemberships.role,
      canView: guardianChildPermissions.canView,
      canEvaluate: guardianChildPermissions.canEvaluate,
      canManageRules: guardianChildPermissions.canManageRules,
      canManageCoupons: guardianChildPermissions.canManageCoupons,
      canReceiveNotifications: guardianChildPermissions.canReceiveNotifications,
    })
    .from(children)
    .innerJoin(
      familyMemberships,
      and(
        eq(familyMemberships.familyId, children.familyId),
        eq(familyMemberships.userId, userId),
        eq(familyMemberships.status, "ACTIVE"),
      ),
    )
    .innerJoin(
      guardianChildPermissions,
      and(
        eq(guardianChildPermissions.childId, children.id),
        eq(guardianChildPermissions.membershipId, familyMemberships.id),
      ),
    )
    .where(and(eq(children.id, childId), eq(children.status, "ACTIVE")))
    .limit(1);

  const access = rows[0];
  if (!access) throw new TRPCError({ code: "FORBIDDEN", message: "이 자녀 프로필에 접근할 수 없습니다." });
  if (!hasCapability(access.role, access, capability)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "이 작업을 수행할 권한이 없습니다." });
  }
  return access;
}

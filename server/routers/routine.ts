import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  createAssignment,
  createThreeLevelRubric,
  getChildDashboard,
  listRubricCatalog,
  reconcileChildLedger,
  reverseEvaluation,
  submitEvaluation,
} from "../services/playRoutine";

export const routineRouter = router({
  dashboard: protectedProcedure
    .input(z.object({ childId: z.number().int().positive() }))
    .query(({ ctx, input }) => getChildDashboard(ctx.user.id, input.childId)),
  reconcileLedger: protectedProcedure
    .input(z.object({ childId: z.number().int().positive() }))
    .query(({ ctx, input }) => reconcileChildLedger(ctx.user.id, input.childId)),
  catalog: protectedProcedure
    .input(z.object({ childId: z.number().int().positive() }))
    .query(({ ctx, input }) => listRubricCatalog(ctx.user.id, input.childId)),
  createThreeLevelRubric: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      activityTitle: z.string().trim().min(1).max(160),
      rubricTitle: z.string().trim().min(1).max(160),
      rewardMinutes: z.number().int().positive().max(10080),
      penaltyMinutes: z.number().int().positive().max(10080),
    }))
    .mutation(({ ctx, input }) => createThreeLevelRubric({ userId: ctx.user.id, ...input })),
  createAssignment: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      activityTemplateId: z.number().int().positive(),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().max(1000).optional(),
    }))
    .mutation(({ ctx, input }) => createAssignment({ userId: ctx.user.id, ...input })),
  submitEvaluation: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      assignmentId: z.number().int().positive(),
      rubricVersionId: z.number().int().positive(),
      rubricLevelId: z.number().int().positive().optional(),
      applicability: z.enum(["APPLICABLE", "NOT_APPLICABLE"]),
      note: z.string().max(2000).optional(),
      idempotencyKey: z.string().min(12).max(191),
    }))
    .mutation(({ ctx, input }) => submitEvaluation({ userId: ctx.user.id, ...input })),
  reverseEvaluation: protectedProcedure
    .input(z.object({ evaluationId: z.number().int().positive(), reason: z.string().trim().min(2).max(1000) }))
    .mutation(({ ctx, input }) => reverseEvaluation(ctx.user.id, input.evaluationId, input.reason)),
});

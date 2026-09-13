import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  assignCoupon,
  cancelCoupon,
  createCouponTemplate,
  expireCoupon,
  issueCoupon,
  listCoupons,
  redeemCoupon,
} from "../services/coupons";

export const couponsRouter = router({
  list: protectedProcedure
    .input(z.object({ childId: z.number().int().positive() }))
    .query(({ ctx, input }) => listCoupons(ctx.user.id, input.childId)),
  createTemplate: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      code: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9_-]+$/),
      title: z.string().trim().min(1).max(120),
      minutes: z.number().int().positive().max(10080),
    }))
    .mutation(({ ctx, input }) => createCouponTemplate({ userId: ctx.user.id, ...input })),
  issue: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      templateId: z.number().int().positive(),
      serialCode: z.string().trim().min(4).max(120).regex(/^[A-Za-z0-9_-]+$/),
      assignNow: z.boolean().default(true),
      expiresAt: z.date().optional(),
    }))
    .mutation(({ ctx, input }) => issueCoupon({ userId: ctx.user.id, ...input })),
  assign: protectedProcedure
    .input(z.object({ childId: z.number().int().positive(), couponIssueId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => assignCoupon(ctx.user.id, input.childId, input.couponIssueId)),
  redeem: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      couponIssueId: z.number().int().positive(),
      idempotencyKey: z.string().min(12).max(191),
    }))
    .mutation(({ ctx, input }) => redeemCoupon({ userId: ctx.user.id, ...input })),
  cancel: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      couponIssueId: z.number().int().positive(),
      reason: z.string().trim().min(2).max(1000),
    }))
    .mutation(({ ctx, input }) => cancelCoupon({ userId: ctx.user.id, ...input })),
  expire: protectedProcedure
    .input(z.object({
      childId: z.number().int().positive(),
      couponIssueId: z.number().int().positive(),
      reason: z.string().trim().min(2).max(1000),
    }))
    .mutation(({ ctx, input }) => expireCoupon({ userId: ctx.user.id, ...input })),
});

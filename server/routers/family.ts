import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { bootstrapWorkspace, listWorkspace } from "../services/playRoutine";

export const familyRouter = router({
  mine: protectedProcedure.query(({ ctx }) => listWorkspace(ctx.user.id)),
  bootstrap: protectedProcedure
    .input(z.object({
      familyName: z.string().trim().min(1).max(120),
      childName: z.string().trim().min(1).max(80),
    }))
    .mutation(({ ctx, input }) => bootstrapWorkspace(ctx.user.id, input.familyName, input.childName)),
});

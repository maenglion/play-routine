import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import {
  findActiveChildInvitation,
  getOtpRequestAllowance,
  normalizeEmail,
  recordInvitationDeliveryEvent,
} from "../supabaseDb";

const GENERIC_MESSAGE =
  "초대가 유효하면 인증번호를 보냈습니다. 메일함과 스팸함을 확인해 주세요.";

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server configuration is missing");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const supabaseAuthRouter = router({
  requestChildOtp: publicProcedure
    .input(z.object({ email: z.string().email().max(320) }))
    .mutation(async ({ input }) => {
      const email = normalizeEmail(input.email);
      const invitation = await findActiveChildInvitation(email);

      if (!invitation) {
        return { accepted: true, message: GENERIC_MESSAGE } as const;
      }

      const allowance = await getOtpRequestAllowance(invitation.id);
      const requestId = randomUUID();

      if (!allowance.allowed) {
        await recordInvitationDeliveryEvent({
          invitationId: invitation.id,
          eventType: "OTP_RATE_LIMITED",
          requestId,
          detail: {
            recentCount: allowance.recentCount,
            dailyCount: allowance.dailyCount,
          },
        });
        return { accepted: true, message: GENERIC_MESSAGE } as const;
      }

      await recordInvitationDeliveryEvent({
        invitationId: invitation.id,
        eventType: "OTP_REQUESTED",
        requestId,
      });

      const { error } = await getSupabaseServerClient().auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          data: { account_type: "child" },
        },
      });

      await recordInvitationDeliveryEvent({
        invitationId: invitation.id,
        eventType: error ? "OTP_FAILED" : "OTP_SENT",
        requestId: randomUUID(),
        detail: error
          ? { code: error.code ?? "AUTH_ERROR", status: error.status ?? null }
          : { sourceRequestId: requestId },
      });

      return { accepted: true, message: GENERIC_MESSAGE } as const;
    }),
});


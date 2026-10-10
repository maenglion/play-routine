import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import {
  type ChildInvitationLookup,
  findActiveChildInvitation,
  findActiveParentOwnedInvitation,
  normalizeEmail,
  recordInvitationDeliveryEvent,
  reserveOtpRequest,
} from "../supabaseDb";

const CHILD_MESSAGE =
  "초대가 유효하면 확인 메일 발송을 요청했습니다. 메일함과 스팸함을 확인해 주세요.";
const PUBLIC_APP_ORIGIN = "https://playroutine-nkwde3yc.manus.space";

export function normalizeAuthRedirectUrl(redirectTo: string, production = process.env.NODE_ENV === "production") {
  const url = new URL(redirectTo);
  const isPublicApp = url.origin === PUBLIC_APP_ORIGIN;
  const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(url.hostname);
  const isManusPreview = url.hostname.endsWith(".manus.computer");
  if (!isPublicApp && (production || (!isLocalDevelopment && !isManusPreview))) {
    throw new Error("Unsupported authentication redirect origin");
  }
  return `${url.origin}/`;
}

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function sendChildConfirmationEmail(invitation: ChildInvitationLookup, email: string, redirectTo: string) {
  const requestId = randomUUID();
  const allowance = await reserveOtpRequest(invitation.id, requestId);
  if (!allowance.allowed) return;

  let failure: { code: string; status: number | null } | null = null;
  try {
    const { error } = await getSupabaseServerClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: redirectTo, data: { account_type: "child" } },
    });
    if (error) failure = { code: error.code ?? "AUTH_ERROR", status: error.status ?? null };
  } catch {
    failure = { code: "AUTH_REQUEST_FAILED", status: null };
  }
  await recordInvitationDeliveryEvent({
    invitationId: invitation.id,
    eventType: failure ? "OTP_FAILED" : "OTP_SENT",
    requestId: randomUUID(),
    detail: { sourceRequestId: requestId, ...(failure ?? {}) },
  });
}

const emailInput = z.string().trim().email().max(320);
const redirectInput = z.string().url().max(2048);
const genericResponse = () => ({ accepted: true, message: CHILD_MESSAGE }) as const;

export const supabaseAuthRouter = router({
  requestChildOtp: publicProcedure
    .input(z.object({ email: emailInput, redirectTo: redirectInput }))
    .mutation(async ({ input }) => {
      const email = normalizeEmail(input.email);
      const redirectTo = normalizeAuthRedirectUrl(input.redirectTo);
      const invitation = await findActiveChildInvitation(email);
      if (invitation) await sendChildConfirmationEmail(invitation, email, redirectTo);
      return genericResponse();
    }),

  resendChildInvitationEmail: publicProcedure
    .input(z.object({
      accessToken: z.string().max(8192).optional(),
      familyId: z.string().uuid(),
      invitationId: z.string().uuid(),
      email: emailInput,
      redirectTo: redirectInput,
    }))
    .mutation(async ({ input }) => {
      const redirectTo = normalizeAuthRedirectUrl(input.redirectTo);
      if (!input.accessToken) return genericResponse();
      let authUserId: string | undefined;
      try {
        const { data, error } = await getSupabaseServerClient().auth.getUser(input.accessToken);
        if (!error) authUserId = data.user?.id;
      } catch {
        return genericResponse();
      }
      if (!authUserId) return genericResponse();
      const email = normalizeEmail(input.email);
      const invitation = await findActiveParentOwnedInvitation({
        authUserId, familyId: input.familyId, invitationId: input.invitationId, email,
      });
      if (invitation) await sendChildConfirmationEmail(invitation, email, redirectTo);
      return genericResponse();
    }),
});

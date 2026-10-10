import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { Loader2, MailPlus, ShieldCheck, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export type GuardianInvitation = {
  id: string;
  email_masked: string;
  status: "ACTIVE" | "ACCEPTED" | "CANCELED" | "EXPIRED";
  expires_at: string;
  accepted_at: string | null;
};


/** Home.tsx wiring contract; exported here because Home is intentionally a shared file. */
export const GUARDIAN_HOME_INTEGRATION_INSTRUCTIONS = [
  "1. Add guardian to AccountMode and render GuardianDashboard when the active membership role is GUARDIAN; pass family { id: membership.family_id } and onLogout={logout}.",
  "2. In refreshAccount, call list_my_active_guardian_invitations after email verification and keep its rows in GuardianInvitationDiscovery state. Do not query guardian_invitations directly for a guardian.",
  "3. For guardian first connection, call supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true, emailRedirectTo: getAuthRedirectUrl(window.location.origin), data: { account_type: 'guardian', display_name: displayName.trim() } } }); then reuse the existing password-setup flow.",
  "4. After verified sign-in, call complete_guardian_invitation({ p_invitation_id: invitation.invitation_id }); refreshAccount(session) on success. Show the same generic unavailable message for every RPC failure.",
  "5. Render <GuardianSettings familyId={parentMembership.family_id} onInvitationCreated={() => refreshAccount(session)} /> only in the parent workspace. Do not add a client-side revoke control without an explicit confirmation dialog.",
] as const;

export type GuardianInvitationDiscovery = {
  invitation_id: string;
  family_id: string;
  family_name: string;
  email_masked: string;
  expires_at: string;
};

export type GuardianInvitationAcceptance = {
  family_id: string;
  principal_id: string;
  membership_id: string;
  status: "ACTIVE";
};

export type GuardianSettingsProps = {
  /** The active parent family. Required outside the development preview. */
  familyId?: string | null;
  /** Renders safe sample data and never calls Supabase. */
  preview?: boolean;
  /** Allows Home to refresh membership-dependent state after a new invite. */
  onInvitationCreated?: () => void | Promise<void>;
};

const previewInvitations: GuardianInvitation[] = [
  {
    id: "preview-guardian-invitation",
    email_masked: "gu***@example.com",
    status: "ACTIVE",
    expires_at: "2099-01-01T00:00:00.000Z",
    accepted_at: null,
  },
];

function statusLabel(status: GuardianInvitation["status"]) {
  if (status === "ACTIVE") return "수락 대기";
  if (status === "ACCEPTED") return "연결됨";
  if (status === "EXPIRED") return "만료됨";
  return "취소됨";
}

/**
 * Parent-only settings. The database RPC independently enforces the parent role;
 * this component never sends an email or exposes an invitation fingerprint.
 */
export default function GuardianSettings({
  familyId,
  preview = false,
  onInvitationCreated,
}: GuardianSettingsProps) {
  const [email, setEmail] = useState("");
  const [invitations, setInvitations] = useState<GuardianInvitation[]>(
    preview ? previewInvitations : [],
  );
  const [loading, setLoading] = useState(!preview && Boolean(familyId));
  const [creating, setCreating] = useState(false);

  const loadInvitations = useCallback(async () => {
    if (preview) {
      setInvitations(previewInvitations);
      setLoading(false);
      return;
    }
    if (!familyId) {
      setInvitations([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const { data, error } = await supabase
      .from("guardian_invitations")
      .select("id, email_masked, status, expires_at, accepted_at")
      .eq("family_id", familyId)
      .order("created_at", { ascending: false });
    setLoading(false);

    if (error) {
      toast.error("보호자 초대 목록을 불러오지 못했습니다.");
      return;
    }
    setInvitations((data ?? []) as GuardianInvitation[]);
  }, [familyId, preview]);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

  const createInvitation = async () => {
    if (!familyId || !email.trim() || preview) return;
    setCreating(true);
    try {
      const { error } = await supabase.rpc("create_guardian_invitation", {
        p_family_id: familyId,
        p_guardian_email: email.trim().toLowerCase(),
      });
      if (error) throw error;
      setEmail("");
      await loadInvitations();
      await onInvitationCreated?.();
      toast.success("보호자 초대를 만들었습니다.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "보호자 초대를 만들지 못했습니다.";
      if (message.includes("ACTIVE_INVITATION_EXISTS")) {
        toast.info("이 이메일에는 이미 유효한 보호자 초대가 있습니다.");
      } else if (message.includes("ACTIVE_FAMILY_MEMBERSHIP_EXISTS")) {
        toast.info("이미 이 가족에 연결된 이메일입니다.");
      } else {
        toast.error("보호자 초대를 만들지 못했습니다.");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-[#4d2ddc]">VIEW ONLY</p>
          <h2 className="mt-1 text-2xl font-bold tracking-[-0.04em]">보호자 보기 권한</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-[#747670]">
            여러 보호자를 초대할 수 있습니다. 보호자는 자녀의 현재 상태만 보고, 프로필·루틴·규칙·기록을 바꾸거나 내려받을 수 없습니다.
          </p>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#f0edfa] text-[#4d2ddc]">
          <UsersRound className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-7 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="guardian-email">보호자 이메일</Label>
          <Input
            id="guardian-email"
            type="email"
            autoCapitalize="none"
            autoComplete="email"
            value={email}
            disabled={creating || preview || !familyId}
            onChange={event => setEmail(event.target.value)}
            placeholder="guardian@example.com"
          />
        </div>
        <Button
          className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"
          disabled={creating || preview || !familyId || !email.trim()}
          onClick={createInvitation}
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailPlus className="h-4 w-4" />}
          초대 만들기
        </Button>
      </div>

      <div className="mt-4 rounded-2xl bg-[#edf7f3] p-4 text-sm leading-6 text-[#315045]">
        <div className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>다음 단계:</strong> 보호자에게 위와 <strong>같은 이메일</strong>로 로그인 화면에서 “보호자 첫 연결”을 선택해 이메일 확인 링크를 요청하라고 안내해 주세요. 인증 후 표시되는 초대를 수락하면 보기 전용 상태판이 열립니다. 이 화면은 메일을 직접 발송하지 않습니다.
          </p>
        </div>
      </div>

      <div className="mt-8 border-t border-black/8 pt-6">
        <div className="mb-4 flex items-center gap-2">
          <MailPlus className="h-4 w-4" />
          <h3 className="font-bold">보호자 초대</h3>
        </div>
        {loading ? (
          <div className="flex items-center justify-center rounded-2xl bg-[#f5f3ed] px-4 py-8 text-sm text-[#777a74]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 불러오는 중
          </div>
        ) : invitations.length === 0 ? (
          <div className="rounded-2xl bg-[#f5f3ed] px-4 py-6 text-center text-sm text-[#777a74]">
            아직 만든 보호자 초대가 없습니다.
          </div>
        ) : (
          <div className="space-y-3">
            {invitations.map(invitation => (
              <div key={invitation.id} className="flex items-center justify-between gap-4 rounded-2xl border border-black/8 p-4">
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{invitation.email_masked}</strong>
                  <p className="mt-1 text-xs text-[#777a74]">
                    {invitation.status === "ACTIVE"
                      ? `${new Date(invitation.expires_at).toLocaleDateString("ko-KR")}까지 수락 가능`
                      : invitation.accepted_at
                        ? `${new Date(invitation.accepted_at).toLocaleDateString("ko-KR")} 연결됨`
                        : "더 이상 사용할 수 없는 초대"}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${invitation.status === "ACCEPTED" ? "bg-[#e4f1eb] text-[#315f4d]" : invitation.status === "ACTIVE" ? "bg-[#f0edfa] text-[#5b46a3]" : "bg-[#efefec] text-[#737670]"}`}>
                  {statusLabel(invitation.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ChildDashboard, { type ChildProfile } from "@/components/play-routine/ChildDashboard";
import ParentDashboard, { type ParentChildProfile, type ParentChildInvitation } from "@/components/play-routine/ParentDashboard";
import GuardianDashboard from "@/components/play-routine/GuardianDashboard";
import {
  defaultAuthModeForAccount,
  isActiveInvitationExistsError,
  needsPasswordSetup,
} from "@/lib/auth-flow";
import { getRememberMePreference, setRememberMePreference } from "@/lib/auth-storage";
import { getAuthRedirectUrl, receiveAuthSession } from "@/lib/auth-callback";
import { initialLoginSelectionFromSearch } from "@/lib/login-role-preference";
import { initialAuthCallback, supabase } from "@/lib/supabase";
import { RECOVERY_NOTICE, RECOVERY_SESSION_KEY, passwordsMatch, requestPasswordRecovery, requiresRecoverySetup } from "@/lib/password-recovery";
import { trpc } from "@/lib/trpc";
import type { Session } from "@supabase/supabase-js";
import { ArrowRight, Clock3, Loader2, LockKeyhole, LogIn, LogOut, Mail, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type AccountMode = "parent" | "child" | "guardian";
type AuthMode = "login" | "signup" | "reset";

type FamilyMembership = {
  family_id: string;
  role: string;
  status: string;
  families: { id: string; name: string; timezone: string } | null;
};

type ChildInvitation = {
  invitation_id: string;
  family_id: string;
  family_name: string;
  child_profile_id: string;
  child_display_name: string;
  email_masked: string;
  expires_at: string;
};

type GuardianInvitation = { invitation_id: string; family_id: string; family_name: string; email_masked: string; expires_at: string };

export default function Home() {
  const [initialLoginSelection] = useState(() => initialLoginSelectionFromSearch(window.location.search));
  // ?role=child 는 자녀 탭을 여는 링크일 뿐이다. 이미 연결된 자녀는 기본 로그인으로 들어온다.
  // 탭을 직접 바꿀 때의 첫 연결/가입 기본값은 아래 Tabs onValueChange에서 기존 규칙을 유지한다.
  const [mode, setMode] = useState<AccountMode>(initialLoginSelection.mode);
  const [authMode, setAuthMode] = useState<AuthMode>(initialLoginSelection.authMode);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [recoveryLink, setRecoveryLink] = useState(initialAuthCallback.isRecovery);
  const [recoveryUserId, setRecoveryUserId] = useState(() => window.sessionStorage.getItem(RECOVERY_SESSION_KEY));
  const [emailSent, setEmailSent] = useState(false);
  const [rememberMe, setRememberMe] = useState(() =>
    typeof window === "undefined" ? true : getRememberMePreference(window.localStorage),
  );
  const [displayName, setDisplayName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [memberships, setMemberships] = useState<FamilyMembership[]>([]);
  const [childInvitations, setChildInvitations] = useState<ChildInvitation[]>([]);
  const [guardianInvitations, setGuardianInvitations] = useState<GuardianInvitation[]>([]);
  const [childProfiles, setChildProfiles] = useState<ParentChildProfile[]>([]);
  const [parentInvitations, setParentInvitations] = useState<ParentChildInvitation[]>([]);
  const [resendInvitationId, setResendInvitationId] = useState<string | null>(null);
  const [resendEmail, setResendEmail] = useState("");
  const [childName, setChildName] = useState("");
  const [childEmail, setChildEmail] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestChildOtp = trpc.supabaseAuth.requestChildOtp.useMutation();
  const resendChildEmail = trpc.supabaseAuth.resendChildInvitationEmail.useMutation();

  const refreshAccount = useCallback(async (activeSession: Session | null) => {
    if (!activeSession) {
      setMemberships([]);
      setChildInvitations([]);
      setGuardianInvitations([]);
      setChildProfiles([]);
      setParentInvitations([]);
      setResendInvitationId(null);
      setResendEmail("");
      return;
    }

    const accountType = activeSession.user.user_metadata?.account_type;
    if (accountType === "child" || accountType === "parent" || accountType === "guardian") setMode(accountType);
    const { data: membershipRows, error: membershipError } = await supabase
      .from("family_memberships")
      .select("family_id, role, status, families(id, name, timezone)")
      .eq("status", "ACTIVE");
    if (membershipError) throw membershipError;

    const normalizedMemberships = (membershipRows ?? []) as unknown as FamilyMembership[];
    setMemberships(normalizedMemberships);
    const parent = normalizedMemberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
    const child = normalizedMemberships.find(row => row.role === "CHILD");
    const guardian = normalizedMemberships.find(row => row.role === "GUARDIAN");
    if (parent) setMode("parent");
    if (child && !parent) setMode("child");
    if (guardian && !parent && !child) setMode("guardian");

    if (!parent) setParentInvitations([]);
    if (parent) {
      const { data: children, error } = await supabase
        .from("child_profiles")
        .select("id, display_name, status, avatar_url")
        .eq("family_id", parent.family_id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      setChildProfiles((children ?? []) as ParentChildProfile[]);
      const { data: invitations, error: invitationsError } = await supabase
        .from("child_invitations")
        .select("id, child_profile_id, email_masked, status, expires_at")
        .eq("family_id", parent.family_id)
        .eq("status", "ACTIVE")
        .gt("expires_at", new Date().toISOString());
      if (invitationsError) throw invitationsError;
      setParentInvitations((invitations ?? []) as ParentChildInvitation[]);
    } else if (child) {
      const { data: profiles, error } = await supabase
        .from("child_profiles")
        .select("id, family_id, display_name, status, avatar_url, avatar_updated_at")
        .eq("family_id", child.family_id)
        .limit(1);
      if (error) throw error;
      setChildProfiles((profiles ?? []) as ParentChildProfile[]);
    } else {
      setChildProfiles([]);
    }

    const { data: invitationRows, error: invitationError } = await supabase.rpc("list_my_active_child_invitations");
    if (invitationError) throw invitationError;
    setChildInvitations((invitationRows ?? []) as ChildInvitation[]);
    const { data: guardianRows, error: guardianError } = await supabase.rpc("list_my_active_guardian_invitations");
    if (guardianError) throw guardianError;
    setGuardianInvitations((guardianRows ?? []) as GuardianInvitation[]);
    if (!parent && !child && (guardianRows ?? []).length > 0) setMode("guardian");
  }, []);

  useEffect(() => {
    let mounted = true;
    const restore = async () => {
      try {
        const nextSession = await receiveAuthSession(supabase.auth, initialAuthCallback);
        if (!mounted) return;
        setSession(nextSession);
        if (initialAuthCallback.isRecovery && nextSession) {
          setRecoveryUserId(nextSession.user.id);
          window.sessionStorage.setItem(RECOVERY_SESSION_KEY, nextSession.user.id);
        }
        await refreshAccount(nextSession);
      } catch {
        if (mounted) setAuthError(initialAuthCallback.errorMessage ?? "인증 또는 계정 정보를 불러오지 못했습니다. 새 확인 메일을 요청하거나 다시 로그인해 주세요.");
      } finally {
        if (initialAuthCallback.isCallback) window.history.replaceState(null, "", initialAuthCallback.cleanPath);
        if (mounted) setLoading(false);
      }
    };
    void restore();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted || (_event === "INITIAL_SESSION" && initialAuthCallback.errorMessage)) return;
      setSession(nextSession);
      if (_event === "PASSWORD_RECOVERY" && nextSession) {
        setRecoveryLink(true);
        setRecoveryUserId(nextSession.user.id);
        window.sessionStorage.setItem(RECOVERY_SESSION_KEY, nextSession.user.id);
        setPassword(""); setPasswordConfirmation("");
      }
      if (_event === "SIGNED_OUT") {
        setRecoveryLink(false); setRecoveryUserId(null);
        window.sessionStorage.removeItem(RECOVERY_SESSION_KEY);
      }
      window.setTimeout(() => {
        if (!mounted) return;
        refreshAccount(nextSession).catch(() => {
          if (mounted) setAuthError("계정 정보를 불러오지 못했습니다. 다시 로그인해 주세요.");
        });
      }, 0);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshAccount]);

  const applyRememberMe = () => {
    setRememberMePreference(rememberMe, window.localStorage, window.sessionStorage);
  };

  const requestSignupLink = async () => {
    setBusy(true);
    try {
      setAuthError(null);
      applyRememberMe();
      if (mode === "child") {
        const result = await requestChildOtp.mutateAsync({
          email,
          redirectTo: getAuthRedirectUrl(window.location.origin),
        });
        toast.success(result.message);
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email: email.trim().toLowerCase(),
          options: {
            shouldCreateUser: true,
            emailRedirectTo: getAuthRedirectUrl(window.location.origin),
            data: { account_type: mode, display_name: displayName.trim() },
          },
        });
        if (error) throw error;
        toast.success("확인 링크를 보냈습니다. 메일함을 확인해 주세요.");
      }
      setEmailSent(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "확인 메일 요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPassword = async () => {
    setBusy(true);
    try {
      setAuthError(null);
      applyRememberMe();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
      let activeSession = data.session;
      if (data.user && needsPasswordSetup(data.user.user_metadata)) {
        const { error: metadataError } = await supabase.auth.updateUser({
          data: { password_configured: true },
        });
        if (metadataError) throw metadataError;
        activeSession = (await supabase.auth.getSession()).data.session ?? activeSession;
      }
      setSession(activeSession);
      await refreshAccount(activeSession);
      toast.success("로그인되었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "이메일과 비밀번호를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const requestResetLink = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setAuthError(null); applyRememberMe();
      const notice = await requestPasswordRecovery(supabase.auth, email, window.location.origin);
      setEmailSent(true); toast.info(notice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "재설정 메일 요청에 실패했습니다.");
    } finally { setBusy(false); }
  };

  const finishPasswordSetup = async () => {
    if (!session || busy || (requiresRecoverySetup(session.user.id, recoveryLink, recoveryUserId) && !passwordsMatch(password, passwordConfirmation))) return;
    setBusy(true);
    try {
      applyRememberMe();
      const { error } = await supabase.auth.updateUser({
        password,
        data: { password_configured: true },
      });
      if (error) throw error;
      const wasRecovery = requiresRecoverySetup(session.user.id, recoveryLink, recoveryUserId);
      setRecoveryLink(false); setRecoveryUserId(null);
      window.sessionStorage.removeItem(RECOVERY_SESSION_KEY);
      setPassword(""); setPasswordConfirmation("");
      const activeSession = (await supabase.auth.getSession()).data.session;
      setSession(activeSession);
      await refreshAccount(activeSession);
      toast.success(wasRecovery ? "새 비밀번호로 변경되었습니다. 기존 가족 연결은 그대로입니다." : "비밀번호 설정이 완료되었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "비밀번호 설정에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const bootstrapFamily = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("bootstrap_parent_family", {
        p_family_name: familyName,
        p_timezone: "Asia/Seoul",
        p_parent_display_name: displayName || null,
      });
      if (error) throw error;
      await refreshAccount(session);
      toast.success("가족 공간을 만들었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "가족 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const inviteChild = async () => {
    const parent = memberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
    if (!parent) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("create_child_invitation", {
        p_family_id: parent.family_id,
        p_child_display_name: childName,
        p_child_email: childEmail,
      });
      if (error) throw error;
      setChildName("");
      setChildEmail("");
      await refreshAccount(session);
      toast.success("자녀 초대를 만들었습니다. 아래 ‘메일 다시 보내기’에서 확인 메일을 요청해 주세요.");
    } catch (error) {
      if (isActiveInvitationExistsError(error)) {
        await refreshAccount(session);
        toast.info("이미 이 이메일의 활성 초대가 있습니다. 자녀 화면에서 첫 연결을 진행해 주세요.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "초대 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const resendInvitation = async () => {
    const parent = memberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
    if (!parent || !resendInvitationId || !resendEmail.trim()) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) throw new Error("부모 계정으로 다시 로그인해 주세요.");
      const result = await resendChildEmail.mutateAsync({
        accessToken: data.session.access_token,
        familyId: parent.family_id,
        invitationId: resendInvitationId,
        email: resendEmail.trim(),
        redirectTo: getAuthRedirectUrl(window.location.origin),
      });
      toast.info(result.message);
      setResendInvitationId(null);
      setResendEmail("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "확인 메일 요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async (dataset: "children" | "invitations" | "auth-links" | "activity-records" | "activity-assignments" | "routine-records" | "routine-rewards" | "october-records" | "october-rights") => {
    const parent = memberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
    if (!session?.access_token || !parent) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ dataset, familyId: parent.family_id });
      const response = await fetch(`/api/exports/family.csv?${params}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (!response.ok) throw new Error("CSV 파일을 만들지 못했습니다.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `play-routine-${dataset}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "CSV 다운로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const acceptInvitation = async (invitationId: string) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc("complete_child_invitation", { p_invitation_id: invitationId });
      if (error) throw error;
      await refreshAccount(session);
      toast.success("부모 계정과 연결되었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "초대 수락에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setPassword("");
    setPasswordConfirmation(""); setRecoveryLink(false); setRecoveryUserId(null);
    window.sessionStorage.removeItem(RECOVERY_SESSION_KEY);
    setEmailSent(false);
  };

  const acceptGuardianInvitation = async (id: string) => {
    setBusy(true);
    try {
      const {error} = await supabase.rpc("complete_guardian_invitation", {p_invitation_id:id});
      if (error) throw new Error("보호자 초대를 수락하지 못했습니다. 이메일과 초대 유효기간을 확인해 주세요.");
      await refreshAccount(session); toast.success("상태를 볼 수 있는 보호자로 연결됐습니다.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "초대 수락에 실패했습니다."); }
    finally { setBusy(false); }
  };

  const parentMembership = memberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
  const childMembership = memberships.find(row => row.role === "CHILD");
  const guardianMembership = memberships.find(row => row.role === "GUARDIAN");
  const childProfile = childMembership ? (childProfiles[0] as ChildProfile | undefined) ?? null : null;
  const passwordRecoveryRequired = requiresRecoverySetup(session?.user.id, recoveryLink, recoveryUserId);
  const passwordSetupRequired = Boolean(
    session && (needsPasswordSetup(session.user.user_metadata) || passwordRecoveryRequired),
  );
  const devPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("preview")
    : null;

  if (devPreview === "child") {
    return (
      <ChildDashboard
        session={{
          access_token: "preview",
          refresh_token: "preview",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: { user_metadata: { display_name: "이민후" } },
        } as unknown as Session}
        profile={{ id: "preview", family_id: "preview", display_name: "이민후", status: "ACTIVE", avatar_url: null, avatar_updated_at: null }}
        onProfileUpdated={() => undefined}
        onLogout={async () => undefined}
        preview
      />
    );
  }

  if (devPreview === "parent") {
    return (
      <ParentDashboard
        family={{ id: "preview", name: "민후네 가족", timezone: "Asia/Seoul" }}
        children={[{ id: "preview", display_name: "이민후", status: "ACTIVE", avatar_url: null }]}
        invitations={[]}
        resendInvitationId={resendInvitationId}
        resendEmail={resendEmail}
        onResendInvitationChange={setResendInvitationId}
        onResendEmailChange={setResendEmail}
        onResendInvitation={() => toast.info("개발 미리보기입니다. 실제 메일은 보내지 않습니다.")}
        childName={childName}
        childEmail={childEmail}
        busy={false}
        onChildNameChange={setChildName}
        onChildEmailChange={setChildEmail}
        onInvite={() => toast.info("개발 미리보기입니다.")}
        onDownloadCsv={() => toast.info("개발 미리보기입니다.")}
        onLogout={() => undefined}
      />
    );
  }

  if (loading) {
    return <div className="flex min-h-dvh items-center justify-center bg-[#f9f6ef]"><Loader2 className="h-7 w-7 animate-spin text-[#4d2ddc]" /></div>;
  }

  if (session && parentMembership && !passwordSetupRequired) {
    return (
      <ParentDashboard
        family={parentMembership.families}
        children={childProfiles}
        invitations={parentInvitations}
        resendInvitationId={resendInvitationId}
        resendEmail={resendEmail}
        onResendInvitationChange={setResendInvitationId}
        onResendEmailChange={setResendEmail}
        onResendInvitation={resendInvitation}
        childName={childName}
        childEmail={childEmail}
        busy={busy}
        onChildNameChange={setChildName}
        onChildEmailChange={setChildEmail}
        onInvite={inviteChild}
        onDownloadCsv={downloadCsv}
        onLogout={logout}
        onProfileUpdated={next => setChildProfiles(rows => rows.map(row => row.id === next.id ? next : row))}
      />
    );
  }

  if (session && childMembership && !passwordSetupRequired) {
    return <ChildDashboard session={session} profile={childProfile} onProfileUpdated={next => setChildProfiles([next])} onLogout={logout} timezone={childMembership.families?.timezone ?? "Asia/Seoul"} />;
  }

  if (session && guardianMembership && !passwordSetupRequired) {
    return <GuardianDashboard session={session} family={{id:guardianMembership.family_id,name:guardianMembership.families?.name ?? "보호자 상태판",timezone:"Asia/Seoul"}} onLogout={logout} />;
  }

  return (
    <div className="min-h-dvh bg-[#f9f6ef] text-[#171713]">
      <div className="mx-auto grid min-h-dvh max-w-7xl lg:grid-cols-[1.05fr_.95fr]">
        <section className="relative hidden overflow-hidden bg-[#333a44] p-14 text-[#f9f6ef] lg:flex lg:flex-col lg:justify-between">
          <div className="absolute -right-28 -top-20 h-80 w-80 rounded-full border border-white/12" />
          <div className="absolute -right-10 top-16 h-52 w-52 rounded-full border border-[#8d78ef]/35" />
          <div className="relative">
            <div className="mb-12 inline-flex items-center gap-2 rounded-full bg-[#4d2ddc] px-4 py-2 text-sm font-semibold"><Sparkles className="h-4 w-4" /> Play Routine</div>
            <h1 className="max-w-xl text-6xl font-bold leading-[1.05] tracking-[-0.06em]">잔소리 덜하고<br />좋은 습관 만들기</h1>
            <p className="mt-7 max-w-lg text-lg leading-8 text-white/65">신경다양성 부모가 만든 신경다양성을 위한 긍정강화 프로젝트</p>
          </div>
            <div className="relative grid grid-cols-3 gap-5 border-t border-white/12 pt-8 text-sm text-white/60">
              <div><strong className="mb-2 block text-2xl text-white">01</strong>부모가 초대</div>
              <div><strong className="mb-2 block text-2xl text-white">02</strong>자녀 이메일 등록</div>
              <div><strong className="mb-2 block text-2xl text-white">03</strong>자녀 로그인</div>
            </div>
        </section>

        <main className="flex items-center justify-center p-5 sm:p-10 lg:p-14">
          <div className="w-full max-w-xl">
            <div className="mb-8 flex items-center justify-between">
              <div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#777a74]">Play Routine</p><h2 className="mt-2 text-3xl font-bold tracking-[-0.05em]">부모·자녀 계정 연결</h2></div>
              {session && <Button variant="ghost" size="icon" onClick={logout} aria-label="로그아웃"><LogOut className="h-5 w-5" /></Button>}
            </div>

            {authError && <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">{authError}</div>}
            {!session ? (
              <Card className="rounded-[28px] border-black/8 bg-white/85 shadow-[0_24px_80px_rgba(51,58,68,.10)] backdrop-blur">
                <CardContent className="pt-6">
                  <Tabs value={mode} onValueChange={value => { const nextMode = value as AccountMode; setMode(nextMode); setAuthMode(defaultAuthModeForAccount(nextMode)); setEmail(""); setPassword(""); setDisplayName(""); setEmailSent(false); }}>
                    <TabsList className="grid w-full grid-cols-3 rounded-full bg-[#ebe7de] p-1">
                      <TabsTrigger value="parent" className="rounded-full data-[state=active]:bg-[#4d2ddc] data-[state=active]:text-white">부모</TabsTrigger>
                      <TabsTrigger value="child" className="rounded-full data-[state=active]:bg-[#4d2ddc] data-[state=active]:text-white">자녀</TabsTrigger>
                      <TabsTrigger value="guardian" className="rounded-full data-[state=active]:bg-[#4d2ddc] data-[state=active]:text-white">보호자</TabsTrigger>
                    </TabsList>
                    <div className="mt-5 grid grid-cols-2 rounded-xl bg-[#f2efe8] p-1 text-sm font-semibold">
                      <button type="button" aria-pressed={authMode === "login"} className={`rounded-lg px-3 py-2.5 transition ${authMode === "login" ? "bg-white text-[#171713] shadow-sm" : "text-[#777a74]"}`} onClick={() => { setAuthMode("login"); setEmailSent(false); }}>로그인</button>
                      <button type="button" aria-pressed={authMode === "signup"} className={`rounded-lg px-3 py-2.5 transition ${authMode === "signup" ? "bg-white text-[#171713] shadow-sm" : "text-[#777a74]"}`} onClick={() => { setAuthMode("signup"); setEmailSent(false); }}>{mode !== "parent" ? "첫 연결" : "가입"}</button>
                    </div>
                    <div className="mt-5 rounded-2xl bg-[#cde5de] p-4 text-sm leading-6 text-[#315045]"><strong>(1)</strong> 부모 먼저 가입 <span className="mx-1.5">→</span> <strong>(2)</strong> 기입한 자녀 이메일로 자녀 로그인</div>
                    <p className="mt-3 text-center text-xs leading-5 text-[#737670]">이 기기에서 자주 쓴다면 브라우저 메뉴에서 ‘홈 화면에 추가’를 선택해 앱처럼 열 수 있어요.</p>
                    <TabsContent value="parent" className="mt-5 space-y-5">
                      {authMode === "signup" && !emailSent && <div className="space-y-2"><Label htmlFor="display-name">부모 이름</Label><Input id="display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="이름" /></div>}
                    </TabsContent>
                    <TabsContent value="child" className="mt-5"><div className="rounded-2xl bg-[#d4cfe7] p-4 text-sm leading-6 text-[#51447f]">자녀 가입은 부모가 먼저 등록한 이메일과 같아야 합니다.</div></TabsContent>
                    <TabsContent value="guardian" className="mt-5"><div className="rounded-2xl bg-[#d4cfe7] p-4 text-sm leading-6 text-[#51447f]">부모가 초대한 같은 이메일로 확인 후 수락합니다. 보호자는 상태창만 볼 수 있고 규칙·프로필·기록을 변경할 수 없습니다.</div></TabsContent>
                    <div className="mt-5 space-y-2"><Label htmlFor="email">이메일</Label><Input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" disabled={emailSent} /></div>
                    {authMode === "signup" && emailSent && <div className="mt-5 rounded-2xl border border-[#b9d7ce] bg-[#edf7f3] p-4 text-sm leading-6 text-[#315045]"><strong>확인 메일을 보냈습니다.</strong><br />메일의 확인 링크를 누르면 Play Routine으로 돌아와 비밀번호를 설정합니다.</div>}
                    {authMode === "reset" && <div role="status" className="mt-5 rounded-2xl border border-[#b9d7ce] bg-[#edf7f3] p-4 text-sm leading-6 text-[#315045]"><strong>비밀번호 재설정</strong><p>{emailSent ? RECOVERY_NOTICE : "가입했던 이메일로 재설정 링크를 받습니다. 계정을 다시 만들거나 자녀를 다시 연결할 필요는 없습니다."}</p>{emailSent && <p className="mt-2">메일의 최신 링크를 누른 뒤 새 비밀번호를 입력해 주세요. 링크와 비밀번호는 채팅에 보내지 마세요.</p>}</div>}
                    {authMode === "login" && <div className="mt-5 space-y-2"><Label htmlFor="password">비밀번호</Label><div className="relative"><LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a8d87]" /><Input id="password" type="password" minLength={8} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="8자 이상" className="pl-10" /></div></div>}
                    {authMode === "login" && <button type="button" className="mt-3 text-sm font-semibold text-[#4d2ddc] underline underline-offset-4" disabled={busy} onClick={() => { setAuthMode("reset"); setEmailSent(false); setPassword(""); setAuthError(null); }}>비밀번호를 잊었어요</button>}
                    <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-black/8 bg-white/70 px-4 py-3 text-sm text-[#555852]">
                      <input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} className="h-4 w-4 accent-[#4d2ddc]" />
                      <span><strong className="text-[#262722]">자동 로그인</strong><span className="ml-2 text-xs text-[#858881]">이 기기에서 로그인 상태 유지</span></span>
                    </label>
                    <Button className="mt-6 w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={busy || !email || (authMode === "login" && password.length < 8) || (authMode === "signup" && mode === "parent" && !displayName)} onClick={authMode === "login" ? signInWithPassword : authMode === "reset" ? requestResetLink : requestSignupLink}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : authMode === "login" ? <><LogIn className="h-4 w-4" /> 로그인</> : authMode === "reset" ? <><Mail className="h-4 w-4" /> {emailSent ? "재설정 메일 다시 보내기" : "재설정 링크 받기"}</> : emailSent ? <><Mail className="h-4 w-4" /> 확인 메일 다시 보내기</> : <><UserPlus className="h-4 w-4" /> 이메일 확인 링크 받기</>}
                    </Button>
                    {authMode === "reset" && <button type="button" disabled={busy} className="mt-4 w-full text-sm text-[#737670] underline underline-offset-4" onClick={() => { setAuthMode("login"); setEmailSent(false); }}>로그인으로 돌아가기</button>}
                  </Tabs>
                </CardContent>
              </Card>
            ) : passwordSetupRequired ? (
              <Card className="rounded-[28px] border-black/8 bg-white/85 shadow-[0_24px_80px_rgba(51,58,68,.10)]">
                <CardHeader><CardTitle>{passwordRecoveryRequired ? "새 비밀번호 설정" : "비밀번호 설정"}</CardTitle><CardDescription>{passwordRecoveryRequired ? "이메일 본인 확인이 완료되었습니다. 새 비밀번호를 정해 주세요. 기존 가족과 자녀 연결은 유지됩니다." : "이메일 확인이 완료되었습니다. 다음 로그인에 사용할 비밀번호를 정해 주세요."}</CardDescription></CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2"><Label htmlFor="new-password">새 비밀번호</Label><div className="relative"><LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a8d87]" /><Input id="new-password" type="password" minLength={8} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="8자 이상" className="pl-10" /></div></div>
                  {passwordRecoveryRequired && <div className="space-y-2"><Label htmlFor="confirm-password">새 비밀번호 확인</Label><Input id="confirm-password" type="password" autoComplete="new-password" value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} placeholder="같은 비밀번호를 다시 입력" />{passwordConfirmation && !passwordsMatch(password, passwordConfirmation) && <p role="status" className="text-xs text-red-700">8자 이상이며 두 비밀번호가 같아야 합니다.</p>}</div>}
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/8 bg-white/70 px-4 py-3 text-sm text-[#555852]"><input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} className="h-4 w-4 accent-[#4d2ddc]" /><span><strong className="text-[#262722]">자동 로그인</strong><span className="ml-2 text-xs text-[#858881]">이 기기에서 로그인 상태 유지</span></span></label>
                  <Button className="w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={busy || password.length < 8 || (passwordRecoveryRequired && !passwordsMatch(password, passwordConfirmation))} onClick={finishPasswordSetup}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShieldCheck className="h-4 w-4" /> {passwordRecoveryRequired ? "새 비밀번호 저장" : "비밀번호 설정 완료"}</>}</Button>
                </CardContent>
              </Card>
            ) : guardianInvitations.length > 0 && mode === "guardian" ? (
              <div className="space-y-4">
                {guardianInvitations.map(invitation => <Card key={invitation.invitation_id} className="rounded-[24px] border-black/8 bg-white/85"><CardHeader><CardTitle>{invitation.family_name}</CardTitle><CardDescription>상태창 보기 전용 · {invitation.email_masked}</CardDescription></CardHeader><CardContent><Button className="w-full rounded-xl bg-[#4d2ddc] text-white" disabled={busy} onClick={() => acceptGuardianInvitation(invitation.invitation_id)}>보호자 초대 수락</Button></CardContent></Card>)}
              </div>
            ) : childInvitations.length > 0 ? (
              <div className="space-y-4">
                <div className="rounded-2xl bg-[#d4cfe7] p-4 text-sm text-[#51447f]">이메일 인증이 완료되었습니다. 연결할 가족 초대를 확인하세요.</div>
                {childInvitations.map(invitation => (
                  <Card key={invitation.invitation_id} className="rounded-[24px] border-black/8 bg-white/85">
                    <CardHeader><CardTitle>{invitation.family_name}</CardTitle><CardDescription>{invitation.child_display_name} · {invitation.email_masked}</CardDescription></CardHeader>
                    <CardContent><Button className="w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={busy} onClick={() => acceptInvitation(invitation.invitation_id)}>초대 수락 <ArrowRight className="h-4 w-4" /></Button></CardContent>
                  </Card>
                ))}
              </div>
            ) : mode === "parent" ? (
              <Card className="rounded-[28px] border-black/8 bg-white/85">
                <CardHeader><CardTitle>가족 공간 만들기</CardTitle><CardDescription>첫 가족 공간은 부모 계정에 소유자로 연결됩니다.</CardDescription></CardHeader>
                <CardContent className="space-y-4"><div className="space-y-2"><Label htmlFor="family-name">가족 공간 이름</Label><Input id="family-name" value={familyName} onChange={event => setFamilyName(event.target.value)} placeholder="우리 가족" /></div><Button className="w-full rounded-xl bg-[#4d2ddc] text-white" disabled={busy || !familyName} onClick={bootstrapFamily}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "가족 공간 시작"}</Button></CardContent>
              </Card>
            ) : (
              <Card className="rounded-[28px] border-black/8 bg-white/85 text-center"><CardContent className="py-12"><Clock3 className="mx-auto mb-4 h-8 w-8 text-[#4d2ddc]" /><h3 className="text-xl font-bold">유효한 초대를 찾지 못했습니다</h3><p className="mt-3 text-sm leading-6 text-[#737670]">부모가 등록한 이메일과 지금 인증한 이메일이 같은지 확인해 주세요.</p></CardContent></Card>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

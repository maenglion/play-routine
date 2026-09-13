import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ChildDashboard, { type ChildProfile } from "@/components/play-routine/ChildDashboard";
import ParentDashboard, { type ParentChildProfile } from "@/components/play-routine/ParentDashboard";
import { getRememberMePreference, setRememberMePreference } from "@/lib/auth-storage";
import { supabase } from "@/lib/supabase";
import { trpc } from "@/lib/trpc";
import type { Session } from "@supabase/supabase-js";
import { ArrowRight, Clock3, Loader2, LockKeyhole, LogIn, LogOut, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type AccountMode = "parent" | "child";
type AuthMode = "login" | "signup";

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

export default function Home() {
  const [mode, setMode] = useState<AccountMode>("parent");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [rememberMe, setRememberMe] = useState(() =>
    typeof window === "undefined" ? true : getRememberMePreference(window.localStorage),
  );
  const [displayName, setDisplayName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [memberships, setMemberships] = useState<FamilyMembership[]>([]);
  const [childInvitations, setChildInvitations] = useState<ChildInvitation[]>([]);
  const [childProfiles, setChildProfiles] = useState<ParentChildProfile[]>([]);
  const [childName, setChildName] = useState("");
  const [childEmail, setChildEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const requestChildOtp = trpc.supabaseAuth.requestChildOtp.useMutation();

  const refreshAccount = useCallback(async (activeSession: Session | null) => {
    if (!activeSession) {
      setMemberships([]);
      setChildInvitations([]);
      setChildProfiles([]);
      return;
    }

    const { data: membershipRows, error: membershipError } = await supabase
      .from("family_memberships")
      .select("family_id, role, status, families(id, name, timezone)")
      .eq("status", "ACTIVE");
    if (membershipError) throw membershipError;

    const normalizedMemberships = (membershipRows ?? []) as unknown as FamilyMembership[];
    setMemberships(normalizedMemberships);
    const parent = normalizedMemberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
    const child = normalizedMemberships.find(row => row.role === "CHILD");
    if (parent) setMode("parent");
    if (child && !parent) setMode("child");

    if (parent) {
      const { data: children, error } = await supabase
        .from("child_profiles")
        .select("id, display_name, status, avatar_url")
        .eq("family_id", parent.family_id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      setChildProfiles((children ?? []) as ParentChildProfile[]);
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
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      try {
        await refreshAccount(data.session);
      } catch (error) {
        console.error(error);
      } finally {
        if (mounted) setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      window.setTimeout(() => refreshAccount(nextSession).catch(console.error), 0);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [refreshAccount]);

  const applyRememberMe = () => {
    setRememberMePreference(rememberMe, window.localStorage, window.sessionStorage);
  };

  const requestSignupOtp = async () => {
    setBusy(true);
    try {
      applyRememberMe();
      if (mode === "child") {
        const result = await requestChildOtp.mutateAsync({ email });
        toast.success(result.message);
      } else {
        const { error } = await supabase.auth.signInWithOtp({
          email: email.trim().toLowerCase(),
          options: { shouldCreateUser: true, data: { account_type: "parent", display_name: displayName.trim() } },
        });
        if (error) throw error;
        toast.success("인증번호를 보냈습니다. 메일함을 확인해 주세요.");
      }
      setOtpRequested(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "인증번호 요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPassword = async () => {
    setBusy(true);
    try {
      applyRememberMe();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
      setSession(data.session);
      await refreshAccount(data.session);
      toast.success("로그인되었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "이메일과 비밀번호를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    setBusy(true);
    try {
      applyRememberMe();
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: otp.trim(),
        type: "email",
      });
      if (error) throw error;
      const { error: passwordError } = await supabase.auth.updateUser({ password });
      if (passwordError) {
        await supabase.auth.signOut();
        throw passwordError;
      }
      setSession(data.session);
      await refreshAccount(data.session);
      toast.success("이메일 인증과 비밀번호 설정이 완료되었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "인증번호를 확인해 주세요.");
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
      toast.success("자녀 이메일 초대를 만들었습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "초대 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = async (dataset: "children" | "invitations" | "auth-links") => {
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
    setOtp("");
    setPassword("");
    setOtpRequested(false);
  };

  const parentMembership = memberships.find(row => ["OWNER_PARENT", "PARENT"].includes(row.role));
  const childMembership = memberships.find(row => row.role === "CHILD");
  const childProfile = childMembership ? (childProfiles[0] as ChildProfile | undefined) ?? null : null;
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
      />
    );
  }

  if (devPreview === "parent") {
    return (
      <ParentDashboard
        family={{ id: "preview", name: "민후네 가족", timezone: "Asia/Seoul" }}
        children={[{ id: "preview", display_name: "이민후", status: "ACTIVE", avatar_url: null }]}
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

  if (session && parentMembership) {
    return (
      <ParentDashboard
        family={parentMembership.families}
        children={childProfiles}
        childName={childName}
        childEmail={childEmail}
        busy={busy}
        onChildNameChange={setChildName}
        onChildEmailChange={setChildEmail}
        onInvite={inviteChild}
        onDownloadCsv={downloadCsv}
        onLogout={logout}
      />
    );
  }

  if (session && childMembership) {
    return <ChildDashboard session={session} profile={childProfile} onProfileUpdated={next => setChildProfiles([next])} onLogout={logout} />;
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

            {!session ? (
              <Card className="rounded-[28px] border-black/8 bg-white/85 shadow-[0_24px_80px_rgba(51,58,68,.10)] backdrop-blur">
                <CardContent className="pt-6">
                  <Tabs value={mode} onValueChange={value => { setMode(value as AccountMode); setEmail(""); setPassword(""); setDisplayName(""); setOtpRequested(false); setOtp(""); }}>
                    <TabsList className="grid w-full grid-cols-2 rounded-full bg-[#ebe7de] p-1">
                      <TabsTrigger value="parent" className="rounded-full data-[state=active]:bg-[#4d2ddc] data-[state=active]:text-white">부모</TabsTrigger>
                      <TabsTrigger value="child" className="rounded-full data-[state=active]:bg-[#4d2ddc] data-[state=active]:text-white">자녀</TabsTrigger>
                    </TabsList>
                    <div className="mt-5 grid grid-cols-2 rounded-xl bg-[#f2efe8] p-1 text-sm font-semibold">
                      <button type="button" aria-pressed={authMode === "login"} className={`rounded-lg px-3 py-2.5 transition ${authMode === "login" ? "bg-white text-[#171713] shadow-sm" : "text-[#777a74]"}`} onClick={() => { setAuthMode("login"); setOtpRequested(false); setOtp(""); }}>로그인</button>
                      <button type="button" aria-pressed={authMode === "signup"} className={`rounded-lg px-3 py-2.5 transition ${authMode === "signup" ? "bg-white text-[#171713] shadow-sm" : "text-[#777a74]"}`} onClick={() => { setAuthMode("signup"); setOtpRequested(false); setOtp(""); }}>가입</button>
                    </div>
                    <div className="mt-5 rounded-2xl bg-[#cde5de] p-4 text-sm leading-6 text-[#315045]"><strong>(1)</strong> 부모 먼저 가입 <span className="mx-1.5">→</span> <strong>(2)</strong> 기입한 자녀 이메일로 자녀 로그인</div>
                    <TabsContent value="parent" className="mt-5 space-y-5">
                      {authMode === "signup" && !otpRequested && <div className="space-y-2"><Label htmlFor="display-name">부모 이름</Label><Input id="display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="이름" /></div>}
                    </TabsContent>
                    <TabsContent value="child" className="mt-5"><div className="rounded-2xl bg-[#d4cfe7] p-4 text-sm leading-6 text-[#51447f]">자녀 가입은 부모가 먼저 등록한 이메일과 같아야 합니다.</div></TabsContent>
                    <div className="mt-5 space-y-2"><Label htmlFor="email">이메일</Label><Input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" disabled={otpRequested} /></div>
                    <div className="mt-5 space-y-2"><Label htmlFor="password">비밀번호</Label><div className="relative"><LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a8d87]" /><Input id="password" type="password" minLength={8} autoComplete={authMode === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} placeholder="8자 이상" className="pl-10" disabled={otpRequested} /></div></div>
                    {authMode === "signup" && otpRequested && <div className="mt-5 space-y-2"><Label htmlFor="otp">이메일 인증번호 6자리</Label><Input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ""))} placeholder="000000" /></div>}
                    <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-black/8 bg-white/70 px-4 py-3 text-sm text-[#555852]">
                      <input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} className="h-4 w-4 accent-[#4d2ddc]" />
                      <span><strong className="text-[#262722]">자동 로그인</strong><span className="ml-2 text-xs text-[#858881]">이 기기에서 로그인 상태 유지</span></span>
                    </label>
                    <Button className="mt-6 w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={busy || !email || password.length < 8 || (authMode === "signup" && mode === "parent" && !otpRequested && !displayName) || (authMode === "signup" && otpRequested && otp.length !== 6)} onClick={authMode === "login" ? signInWithPassword : otpRequested ? verifyOtp : requestSignupOtp}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : authMode === "login" ? <><LogIn className="h-4 w-4" /> 로그인</> : otpRequested ? <><ShieldCheck className="h-4 w-4" /> 가입 완료</> : <><UserPlus className="h-4 w-4" /> 이메일 인증 후 가입</>}
                    </Button>
                  </Tabs>
                </CardContent>
              </Card>
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

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, FileText, LogOut, Mail, Plus, UsersRound } from "lucide-react";
import ParentAvatarEditor from "./ParentAvatarEditor";
import GuardianSettings from "./GuardianSettings";
import ParentRuleSettings from "./ParentRuleSettings";
import ParentActivitySettings from "./ParentActivitySettings";
import ParentReviewQueue from "./ParentReviewQueue";
import ParentRewardSettings from "./ParentRewardSettings";
import { useState } from "react";

type Family = { id: string; name: string; timezone: string } | null;

export type ParentChildProfile = {
  id: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
};

export type ParentChildInvitation = {
  id: string;
  child_profile_id: string;
  email_masked: string;
  status: string;
  expires_at: string;
};

type ParentDashboardProps = {
  family: Family;
  children: ParentChildProfile[];
  invitations: ParentChildInvitation[];
  resendInvitationId: string | null;
  resendEmail: string;
  onResendInvitationChange: (value: string | null) => void;
  onResendEmailChange: (value: string) => void;
  onResendInvitation: () => void;
  childName: string;
  childEmail: string;
  busy: boolean;
  onChildNameChange: (value: string) => void;
  onChildEmailChange: (value: string) => void;
  onInvite: () => void;
  onDownloadCsv: (dataset: "children" | "invitations" | "auth-links" | "activity-records" | "activity-assignments") => void;
  onLogout: () => void;
  onProfileUpdated?: (child: ParentChildProfile) => void;
};

export default function ParentDashboard({
  family,
  children,
  invitations,
  resendInvitationId,
  resendEmail,
  onResendInvitationChange,
  onResendEmailChange,
  onResendInvitation,
  childName,
  childEmail,
  busy,
  onChildNameChange,
  onChildEmailChange,
  onInvite,
  onDownloadCsv,
  onLogout,
  onProfileUpdated,
}: ParentDashboardProps) {
  const [rulesKey, setRulesKey] = useState(0);
  return (
    <div className="min-h-dvh bg-[#f9f6ef] text-[#1a1a18]">
      <header className="border-b border-black/8 bg-[#333a44] text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Parent workspace</p>
            <h1 className="mt-1 text-xl font-bold tracking-[-0.03em]">{family?.name ?? "가족 공간"}</h1>
          </div>
          <Button variant="ghost" size="icon" onClick={onLogout} className="text-white hover:bg-white/10 hover:text-white" aria-label="로그아웃"><LogOut className="h-5 w-5" /></Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-[22px] bg-[#d4cfe7] p-5"><span className="text-xs font-semibold">연결된 자녀</span><strong className="mt-5 block text-4xl tracking-[-0.06em]">{children.filter(child => child.status === "ACTIVE").length}</strong></div>
          <a href="#parent-review" className="rounded-[22px] bg-[#cde5de] p-5"><span className="text-xs font-semibold">부모 확인</span><strong className="mt-5 block text-xl tracking-[-0.04em]">날짜별 확인하기</strong><span className="mt-2 block text-xs text-[#52675d]">밀린 체크도 수행일로 기록</span></a>
          <div className="rounded-[22px] bg-[#333a44] p-5 text-white"><span className="text-xs font-semibold text-white/65">열린 잔차</span><strong className="mt-5 block text-4xl tracking-[-0.06em]">—</strong><span className="mt-2 block text-xs text-white/65">잔차 큐 연결 전</span></div>
        </div>
        <nav aria-label="부모 설정 바로가기" className="mt-5 flex flex-wrap gap-3 text-sm font-semibold"><a href="#parent-rule-registry" className="rounded-full bg-[#4d2ddc] px-5 py-2.5 text-white">1. 규칙 등록</a><a href="#parent-assignments" className="rounded-full bg-[#d4cfe7] px-5 py-2.5 text-[#4d2ddc]">2. 자녀에게 배정</a><a href="#parent-review" className="rounded-full bg-[#cde5de] px-5 py-2.5 text-[#315f4d]">3. 날짜별 확인</a><a href="#parent-rewards" className="rounded-full bg-[#f0e5c9] px-5 py-2.5 text-[#69521f]">특별보너스·돈 보상</a><a href="#guardian-settings" className="rounded-full bg-[#ebe7de] px-5 py-2.5 text-[#333a44]">보호자 추가</a></nav>

        <div className="mt-7 grid gap-6 lg:grid-cols-[1.08fr_.92fr]">
          <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8">
            <div className="flex items-start justify-between">
              <div><p className="text-xs font-semibold text-[#4d2ddc]">FAMILY</p><h2 className="mt-1 text-2xl font-bold tracking-[-0.04em]">자녀 계정 연결</h2></div>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f0edfa] text-[#4d2ddc]"><Plus className="h-5 w-5" /></div>
            </div>
            <p className="mt-3 text-sm leading-6 text-[#747670]">초대를 만든 뒤 아래 ‘메일 다시 보내기’로 확인 메일을 요청할 수 있습니다. 자녀가 같은 이메일의 확인 링크를 누르고 초대를 수락하면 연결됩니다.</p>
            <div className="mt-7 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="child-name">자녀 이름</Label><Input id="child-name" value={childName} onChange={event => onChildNameChange(event.target.value)} placeholder="이름" /></div>
              <div className="space-y-2"><Label htmlFor="child-email">자녀 이메일</Label><Input id="child-email" type="email" value={childEmail} onChange={event => onChildEmailChange(event.target.value)} placeholder="child@example.com" /></div>
            </div>
            <Button className="mt-5 w-full rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]" disabled={busy || !childName || !childEmail} onClick={onInvite}>초대 만들기</Button>

            <div className="mt-8 border-t border-black/8 pt-6">
              <div className="mb-4 flex items-center gap-2"><UsersRound className="h-4 w-4" /><h3 className="font-bold">자녀 프로필</h3></div>
              {children.length === 0 ? (
                <div className="rounded-2xl bg-[#f5f3ed] px-4 py-6 text-center text-sm text-[#777a74]">아직 등록된 자녀가 없습니다.</div>
              ) : (
                <div className="space-y-3">
                  {children.map(child => {
                    const invitation = invitations.find(row => row.child_profile_id === child.id);
                    return (
                    <div key={child.id} className="rounded-2xl border border-black/8 p-3">
                    <div className="flex items-center gap-3">
                      <ParentAvatarEditor child={child} onUpdated={onProfileUpdated} />
                      <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{child.display_name}</strong><span className="text-xs text-[#8a8b85]">{child.status === "ACTIVE" ? "계정 연결됨" : "초대 대기"}</span></div>
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${child.status === "ACTIVE" ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f0edfa] text-[#5b46a3]"}`}>{child.status}</span>
                    </div>
                    {invitation && <div className="mt-3 border-t border-black/5 pt-3">
                      <p className="mb-3 text-xs text-[#777a74]">{invitation.email_masked} · 연결 전 초대</p>
                      {resendInvitationId === invitation.id ? <div className="space-y-3">
                        <Label htmlFor={`resend-${invitation.id}`}>처음 초대한 자녀 이메일</Label>
                        <Input id={`resend-${invitation.id}`} type="email" autoCapitalize="none" autoComplete="off" value={resendEmail} onChange={event => onResendEmailChange(event.target.value)} placeholder="같은 이메일을 다시 입력" disabled={busy} />
                        <p className="text-xs leading-5 text-[#777a74]">최소 60초 간격, 최근 24시간 최대 5회 요청할 수 있습니다. 새 초대나 프로필은 만들지 않습니다.</p>
                        <div className="flex gap-2"><Button disabled={busy || !resendEmail.trim()} onClick={onResendInvitation} className="rounded-xl bg-[#4d2ddc] text-white hover:bg-[#3d20c7]"><Mail className="h-4 w-4" /> 확인 메일 보내기</Button><Button variant="ghost" disabled={busy} onClick={() => onResendInvitationChange(null)}>취소</Button></div>
                      </div> : <Button variant="outline" disabled={busy} className="rounded-xl" onClick={() => { onResendEmailChange(""); onResendInvitationChange(invitation.id); }}><Mail className="h-4 w-4" /> 메일 다시 보내기</Button>}
                    </div>}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[28px] bg-[#eeeae1] p-6 sm:p-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#333a44]"><FileText className="h-5 w-5" /></div>
            <h2 className="mt-5 text-2xl font-bold tracking-[-0.04em]">기록 내려받기</h2>
            <p className="mt-3 text-sm leading-6 text-[#73766f]">Google Sheets 없이 부모 화면에서 연결·배정·체크·확인 기록을 CSV로 보관합니다. 활동의 분 값은 예정분이며 잔액이 아닙니다.</p>
            <div className="mt-7 space-y-3">
              {([
                ["children", "자녀 프로필"],
                ["invitations", "이메일 초대"],
                ["auth-links", "계정 연결 이력"],
                ["activity-assignments", "활동 배정 일정"],
                ["activity-records", "활동 체크·부모 확인 이력"],
              ] as const).map(([dataset, label]) => (
                <button key={dataset} type="button" disabled={busy} onClick={() => onDownloadCsv(dataset)} className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-4 text-left text-sm font-semibold shadow-[0_5px_15px_rgba(51,58,68,.05)] transition-transform duration-150 active:scale-[.98]">
                  {label}<Download className="h-4 w-4 text-[#4d2ddc]" />
                </button>
              ))}
            </div>
          </section>
        </div>
        <div className="mt-7" id="guardian-settings"><GuardianSettings familyId={family?.id} preview={family?.id === "preview"} /></div>
        {family && <><div className="mt-7" id="parent-rule-registry"><ParentRuleSettings familyId={family.id} preview={family.id === "preview"} onPublished={()=>setRulesKey(key=>key+1)} /></div><div className="mt-7" id="parent-assignments"><ParentActivitySettings refreshKey={rulesKey} familyId={family.id} timezone={family.timezone} children={children} preview={family.id === "preview"}/></div><div className="mt-7" id="parent-review"><ParentReviewQueue familyId={family.id} timezone={family.timezone} children={children} preview={family.id === "preview"}/></div><div className="mt-7" id="parent-rewards"><ParentRewardSettings familyId={family.id} timezone={family.timezone} children={children} preview={family.id === "preview"} /></div></>}
      </main>
    </div>
  );
}

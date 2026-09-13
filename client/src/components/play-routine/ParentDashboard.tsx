import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, FileText, LogOut, Plus, UsersRound } from "lucide-react";

type Family = { id: string; name: string; timezone: string } | null;

export type ParentChildProfile = {
  id: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
};

type ParentDashboardProps = {
  family: Family;
  children: ParentChildProfile[];
  childName: string;
  childEmail: string;
  busy: boolean;
  onChildNameChange: (value: string) => void;
  onChildEmailChange: (value: string) => void;
  onInvite: () => void;
  onDownloadCsv: (dataset: "children" | "invitations" | "auth-links") => void;
  onLogout: () => void;
};

export default function ParentDashboard({
  family,
  children,
  childName,
  childEmail,
  busy,
  onChildNameChange,
  onChildEmailChange,
  onInvite,
  onDownloadCsv,
  onLogout,
}: ParentDashboardProps) {
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
          <div className="rounded-[22px] bg-[#cde5de] p-5"><span className="text-xs font-semibold">오늘 확인 대기</span><strong className="mt-5 block text-4xl tracking-[-0.06em]">0</strong></div>
          <div className="rounded-[22px] bg-[#333a44] p-5 text-white"><span className="text-xs font-semibold text-white/65">열린 잔차</span><strong className="mt-5 block text-4xl tracking-[-0.06em]">0</strong></div>
        </div>

        <div className="mt-7 grid gap-6 lg:grid-cols-[1.08fr_.92fr]">
          <section className="rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8">
            <div className="flex items-start justify-between">
              <div><p className="text-xs font-semibold text-[#4d2ddc]">FAMILY</p><h2 className="mt-1 text-2xl font-bold tracking-[-0.04em]">자녀 계정 연결</h2></div>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f0edfa] text-[#4d2ddc]"><Plus className="h-5 w-5" /></div>
            </div>
            <p className="mt-3 text-sm leading-6 text-[#747670]">자녀가 실제로 사용할 이메일을 입력하면, 같은 이메일의 OTP 인증 후 즉시 연결됩니다.</p>
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
                  {children.map(child => (
                    <div key={child.id} className="flex items-center gap-3 rounded-2xl border border-black/8 p-3">
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-[#d4cfe7] text-sm font-bold text-[#4d2ddc]">
                        {child.avatar_url ? <img src={child.avatar_url} alt="" className="h-full w-full object-cover" /> : child.display_name.slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{child.display_name}</strong><span className="text-xs text-[#8a8b85]">{child.status === "ACTIVE" ? "계정 연결됨" : "초대 대기"}</span></div>
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${child.status === "ACTIVE" ? "bg-[#e4f1eb] text-[#315f4d]" : "bg-[#f0edfa] text-[#5b46a3]"}`}>{child.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[28px] bg-[#eeeae1] p-6 sm:p-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#333a44]"><FileText className="h-5 w-5" /></div>
            <h2 className="mt-5 text-2xl font-bold tracking-[-0.04em]">기록 내려받기</h2>
            <p className="mt-3 text-sm leading-6 text-[#73766f]">Google Sheets 없이 부모 화면에서 필요한 연결 기록을 CSV로 보관합니다.</p>
            <div className="mt-7 space-y-3">
              {([
                ["children", "자녀 프로필"],
                ["invitations", "이메일 초대"],
                ["auth-links", "계정 연결 이력"],
              ] as const).map(([dataset, label]) => (
                <button key={dataset} type="button" disabled={busy} onClick={() => onDownloadCsv(dataset)} className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-4 text-left text-sm font-semibold shadow-[0_5px_15px_rgba(51,58,68,.05)] transition-transform duration-150 active:scale-[.98]">
                  {label}<Download className="h-4 w-4 text-[#4d2ddc]" />
                </button>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

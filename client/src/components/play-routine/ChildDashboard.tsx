import { Button } from "@/components/ui/button";
import type { Session } from "@supabase/supabase-js";
import {
  CalendarDays,
  Camera,
  ChartNoAxesColumnIncreasing,
  Check,
  Clock3,
  Home,
  Loader2,
  LogOut,
  UserRound,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

export type ChildProfile = {
  id: string;
  family_id: string;
  display_name: string;
  status: string;
  avatar_url: string | null;
  avatar_updated_at: string | null;
};

type ChildDashboardProps = {
  session: Session;
  profile: ChildProfile | null;
  onProfileUpdated: (profile: ChildProfile) => void;
  onLogout: () => Promise<void>;
};

const navItems = [
  { key: "home", label: "오늘", icon: Home },
  { key: "progress", label: "진행", icon: ChartNoAxesColumnIncreasing },
  { key: "calendar", label: "일정", icon: CalendarDays },
  { key: "profile", label: "프로필", icon: UserRound },
] as const;

function initials(name?: string) {
  const normalized = name?.trim() || "자녀";
  return normalized.slice(0, 1);
}

export default function ChildDashboard({
  session,
  profile,
  onProfileUpdated,
  onLogout,
}: ChildDashboardProps) {
  const [activeTab, setActiveTab] = useState<(typeof navItems)[number]["key"]>("home");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const childName = profile?.display_name || session.user.user_metadata?.display_name || "나의 하루";

  const uploadAvatar = async (file?: File) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error("JPG, PNG, WEBP 이미지만 사용할 수 있습니다.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("프로필 사진은 2MB 이하로 선택해 주세요.");
      return;
    }

    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
        reader.readAsDataURL(file);
      });
      const response = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dataUrl }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "프로필 사진을 저장하지 못했습니다.");
      onProfileUpdated(result.profile as ChildProfile);
      toast.success("프로필 사진을 바꿨어요.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "프로필 사진을 저장하지 못했습니다.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="min-h-dvh bg-[#f9f6ef] text-[#151515]">
      <main className="relative mx-auto min-h-dvh max-w-[430px] overflow-hidden px-4 pb-28 pt-7 sm:px-5">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c7a72]">Play Routine</p>
            <h1 className="mt-1 text-[21px] font-semibold tracking-[-0.03em] text-[#333a44]">{childName}</h1>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={event => uploadAvatar(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="group relative h-11 w-11 overflow-hidden rounded-full border-2 border-[#333a44] bg-[#d4cfe7] shadow-[0_4px_12px_rgba(51,58,68,.12)] transition-transform duration-150 active:scale-[.97]"
              aria-label="프로필 사진 바꾸기"
            >
              {profile?.avatar_url ? (
                <img src={profile.avatar_url} alt={`${childName} 프로필`} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-sm font-bold text-[#4d2ddc]">{initials(childName)}</span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Camera className="h-4 w-4 text-white" />}
              </span>
            </button>
          </div>
        </header>

        {activeTab === "home" ? (
          <>
            <section className="pt-12">
              <div className="flex items-center gap-2 text-xs font-medium text-[#62656a]">
                <CalendarDays className="h-[18px] w-[18px]" />
                {new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date())}
              </div>
              <h2 className="mt-3 text-[30px] font-bold tracking-[-0.055em]">매일 한걸음씩</h2>
            </section>

            <section className="ticket-shell mt-7 grid grid-cols-2 overflow-hidden bg-white shadow-[0_6px_18px_rgba(58,54,47,.12)]">
              <div className="flex min-h-[132px] flex-col justify-center border-r border-dashed border-[#d9d6cf] px-7">
                <span className="text-xs font-semibold text-[#8a8b8d]">오늘 모으는 중</span>
                <div className="mt-2 flex items-baseline gap-1 text-[#8d8f91]">
                  <strong className="text-[34px] leading-none tracking-[-0.05em]">0</strong>
                  <span className="text-sm font-semibold">min</span>
                </div>
                <span className="mt-2 inline-flex w-fit rounded-full bg-[#efefec] px-2.5 py-1 text-[10px] font-semibold text-[#777a7d]">확인 전</span>
              </div>
              <div className="flex min-h-[132px] flex-col justify-center px-7">
                <span className="text-xs font-semibold text-[#4d2ddc]">현재 보유량</span>
                <div className="mt-2 flex items-baseline gap-1 text-[#333a44]">
                  <strong className="text-[34px] leading-none tracking-[-0.05em]">0</strong>
                  <span className="text-sm font-semibold">min</span>
                </div>
                <span className="mt-2 text-[11px] font-medium text-[#898a84]">지금 사용할 수 있어요</span>
              </div>
            </section>

            <section className="mt-9">
              <div className="grid grid-cols-3 rounded-full bg-[#333a44] p-1 text-xs font-semibold text-white">
                <button type="button" className="rounded-full bg-[#4d2ddc] px-3 py-3 shadow-[0_4px_12px_rgba(77,45,220,.32)]">오늘의 루틴 <span className="ml-1 text-white/70">00</span></button>
                <button type="button" className="rounded-full px-3 py-3 text-white/80">완료 <span className="ml-1 text-white/50">00</span></button>
                <button type="button" className="rounded-full px-3 py-3 text-white/80">미완료 <span className="ml-1 text-white/50">00</span></button>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <article className="min-h-[154px] rounded-2xl bg-[#d4cfe7] p-4 shadow-[0_5px_14px_rgba(65,60,78,.10)]">
                  <p className="text-[11px] font-medium">매일공부</p>
                  <h3 className="mt-2 text-lg font-bold leading-snug tracking-[-0.04em]">오늘 할 일을<br />준비하고 있어요</h3>
                  <span className="mt-6 inline-flex items-center gap-1 rounded-full bg-[#333a44] px-2.5 py-1 text-[11px] font-semibold text-white"><Clock3 className="h-3.5 w-3.5" /> 0min</span>
                </article>
                <article className="min-h-[154px] rounded-2xl bg-[#cde5de] p-4 shadow-[0_5px_14px_rgba(65,78,72,.08)]">
                  <p className="text-[11px] font-medium">특별과제</p>
                  <h3 className="mt-2 text-lg font-bold leading-snug tracking-[-0.04em]">부모가 설정하면<br />여기에 보여요</h3>
                  <span className="mt-6 inline-flex items-center gap-1 rounded-full bg-[#333a44] px-2.5 py-1 text-[11px] font-semibold text-white"><Clock3 className="h-3.5 w-3.5" /> 0min</span>
                </article>
              </div>
            </section>

            <section className="mt-11 pb-4">
              <div className="flex items-end gap-2">
                <h2 className="text-2xl font-bold tracking-[-0.05em] text-[#333a44]">오늘자 진행률</h2>
                <strong className="pb-0.5 text-xl text-[#4d2ddc]">0%</strong>
              </div>
              {["매일공부", "특별과제", "생활습관"].map(label => (
                <div key={label} className="mt-6">
                  <div className="mb-2 flex justify-between text-sm font-semibold"><span>{label}</span><span className="text-[#9a9a95]">0 / 0</span></div>
                  <div className="h-3.5 overflow-hidden rounded-full bg-[#ebe7de] shadow-[inset_0_3px_4px_rgba(130,125,116,.12)]">
                    <div className="h-full w-0 rounded-full bg-[#4d2ddc]" />
                  </div>
                </div>
              ))}
            </section>
          </>
        ) : (
          <section className="mt-16 rounded-[28px] bg-white p-8 text-center shadow-[0_12px_40px_rgba(51,58,68,.08)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#f0edfa] text-[#4d2ddc]">
              {activeTab === "profile" ? <UserRound className="h-6 w-6" /> : activeTab === "calendar" ? <CalendarDays className="h-6 w-6" /> : <ChartNoAxesColumnIncreasing className="h-6 w-6" />}
            </div>
            <h2 className="mt-5 text-xl font-bold">{activeTab === "profile" ? "나의 프로필" : activeTab === "calendar" ? "나의 일정" : "나의 진행 기록"}</h2>
            <p className="mt-2 text-sm leading-6 text-[#777a78]">핵심 데이터 구조가 연결되면 이 화면에서 바로 확인할 수 있어요.</p>
            {activeTab === "profile" && <Button variant="outline" className="mt-6" onClick={onLogout}><LogOut className="h-4 w-4" /> 로그아웃</Button>}
          </section>
        )}

        <nav className="fixed bottom-[max(10px,env(safe-area-inset-bottom))] left-1/2 z-40 grid h-[58px] w-[calc(100%-24px)] max-w-[404px] -translate-x-1/2 grid-cols-4 rounded-[30px] bg-black px-4 shadow-[0_14px_35px_rgba(0,0,0,.28)]">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                type="button"
                key={item.key}
                onClick={() => setActiveTab(item.key)}
                className={`flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-full transition-transform duration-150 active:scale-[.97] ${active ? "text-white" : "text-white/48"}`}
                aria-label={item.label}
              >
                <Icon className="h-[21px] w-[21px]" strokeWidth={active ? 2.5 : 2} />
                <span className="text-[9px] font-semibold">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </main>
    </div>
  );
}

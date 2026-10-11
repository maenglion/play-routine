import { Button } from "@/components/ui/button";
import type { Session } from "@supabase/supabase-js";
import {
  CalendarDays,
  Bell,
  Camera,
  ChartNoAxesColumnIncreasing,
  Check,
  Clock3,
  Home,
  RefreshCw,
  Loader2,
  LogOut,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import AvatarCropDialog from "./AvatarCropDialog";
import { blobToDataUrl } from "@/lib/avatar-crop";
import { useActivityDay } from "@/hooks/useActivityDay";
import { familyBusinessDate, summarizeActivityDay } from "@/lib/activity-flow";
import ChildActivityList, { activityCategoryLabels } from "./ChildActivityList";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
  timezone?: string;
  preview?: boolean;
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
  timezone = "Asia/Seoul",
  preview = false,
}: ChildDashboardProps) {
  const [activeTab, setActiveTab] = useState<(typeof navItems)[number]["key"]>("home");
  const [day, setDay] = useState(() => familyBusinessDate(timezone));
  const [today, setToday] = useState(() => familyBusinessDate(timezone));
  const [filter, setFilter] = useState<"all"|"done"|"open">("all");
  useEffect(() => {
    const tick = () => {const date = familyBusinessDate(timezone); setToday(date);};
    tick(); const timer = window.setInterval(tick, 60000);
    return () => window.clearInterval(timer);
  }, [timezone]);
  useEffect(() => {if (activeTab === 'home') setDay(today);}, [today,activeTab]);
  const activity = useActivityDay(profile?.id, day, preview);
  const stats = summarizeActivityDay(activity.rows);
  const [dismissedMissing, setDismissedMissing] = useState<string | null>(null);
  const missingKey = `${profile?.id}:${day}`;
  const showMissing = activeTab === "home" && !activity.loading && !activity.error && stats.missing > 0 && dismissedMissing !== missingKey;
  const visibleRows = activity.rows.filter(row=>filter==='all'||(filter==='done'?row.child_reported||row.verification_status==='CONFIRMED':!row.child_reported&&row.verification_status!=='CONFIRMED'));
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [cropImage, setCropImage] = useState<string | null>(null);
  useEffect(() => () => { if (cropImage) URL.revokeObjectURL(cropImage); }, [cropImage]);
  const childName = profile?.display_name || session.user.user_metadata?.display_name || "나의 하루";

  const selectAvatar = (file?: File) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error("JPG, PNG, WEBP 이미지만 사용할 수 있습니다.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error("원본 사진은 15MB 이하로 선택해 주세요. 자른 사진은 작게 압축합니다.");
      return;
    }
    setCropImage(URL.createObjectURL(file));
    if (inputRef.current) inputRef.current.value = "";
  };

  const uploadAvatar = async (blob: Blob) => {
    setUploading(true);
    try {
      const dataUrl = await blobToDataUrl(blob);
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
      setCropImage(null);
      toast.success("프로필 사진을 바꿨어요.");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "프로필 사진을 저장하지 못했습니다.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="min-h-dvh bg-[#f9f6ef] text-[#151515]">
      <AvatarCropDialog imageUrl={cropImage} onCancel={() => setCropImage(null)} onSave={uploadAvatar} busy={uploading} />
      <Dialog open={showMissing} onOpenChange={open=>{if(!open)setDismissedMissing(missingKey);}}><DialogContent className="h-dvh w-screen max-w-none rounded-none border-0 bg-[#f9f6ef] p-8 sm:max-w-none"><div className="m-auto max-w-sm"><DialogHeader><DialogTitle className="text-3xl leading-tight">아직 체크가 안 되어 있어요</DialogTitle><DialogDescription className="mt-4 text-base leading-7">오늘 할 일 {stats.missing}개에 나와 부모의 확인이 아직 없어요. 했다면 알려주고, 기억나지 않으면 부모와 함께 확인해요. 미확인이라고 보상이나 패널티를 정하지 않아요.</DialogDescription></DialogHeader><Button className="mt-8 w-full rounded-xl bg-[#4d2ddc] text-white" onClick={()=>setDismissedMissing(missingKey)}>할 일 확인하기</Button></div></DialogContent></Dialog>
      <main className="relative mx-auto min-h-dvh max-w-[430px] overflow-hidden px-4 pb-28 pt-7 sm:px-5">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7c7a72]">Play Routine</p>
            <h1 className="mt-1 text-[21px] font-semibold tracking-[-0.03em] text-[#333a44]">{childName}</h1>
          </div>
          <div className="flex h-9 items-center gap-1 rounded-full bg-black p-0.5 pl-2 shadow-none">
            <button type="button" disabled className="flex h-7 w-6 items-center justify-center text-white/60" aria-label="알림 화면 준비 중" title="알림 화면 준비 중"><Bell className="h-4 w-4" /></button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={event => selectAvatar(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="group relative h-8 w-8 overflow-hidden rounded-full bg-[#d4cfe7] shadow-none transition-transform duration-150 active:scale-[.97]"
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
                {new Intl.DateTimeFormat("ko-KR", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date())}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2"><h2 className="text-[30px] font-bold tracking-[-0.055em]">매일 한걸음씩</h2><Button variant="ghost" size="icon" onClick={()=>void activity.refresh()} disabled={activity.loading} aria-label="할 일 새로고침"><RefreshCw className={`h-4 w-4 ${activity.loading?"animate-spin":""}`}/></Button></div>
            </section>

            <section className="ticket-frame mt-7">
            <img src="/manus-storage/Subtract_amount_d9f68ee2.svg" alt="" aria-hidden="true" className="ticket-paper" />
            <div className="ticket-content relative grid grid-cols-2">
              <div className="flex min-h-[132px] flex-col justify-center border-r border-dashed border-[#d9d6cf] px-7">
                <span className="flex items-center gap-2 text-xs font-semibold text-[#8a8b8d]"><img src="/manus-storage/artifact_today_54fa0ca5.svg" alt="" className="h-6 w-6" />오늘 모으는 중</span>
                <div className="mt-2 flex items-baseline gap-1 text-[#8d8f91]">
                  <strong className="text-[34px] leading-none tracking-[-0.05em]">{activity.loading ? "—" : stats.positiveMinutes}</strong>
                  <span className="text-sm font-semibold">min</span>
                </div>
                <span className="mt-2 inline-flex w-fit rounded-full bg-[#efefec] px-2.5 py-1 text-[10px] font-semibold text-[#777a7d]">부모 확인된 예정분</span>
              </div>
              <div className="flex min-h-[132px] flex-col justify-center px-7">
                <span className="flex items-center gap-2 text-xs font-semibold text-[#4d2ddc]"><img src="/manus-storage/artifact_amount_80f85ebe.svg" alt="" className="h-6 w-6" />현재 보유량</span>
                <div className="mt-2 flex items-baseline gap-1 text-[#333a44]">
                  <strong className="text-[34px] leading-none tracking-[-0.05em]">—</strong>
                  <span className="text-sm font-semibold">min</span>
                </div>
                <span className="mt-2 text-[11px] font-medium text-[#898a84]">원장 연결 전 · 사용 불가</span>
              </div>
            </div>
            </section>

            <section className="mt-9">
              <div className="grid grid-cols-3 rounded-full bg-[#333a44] p-1 text-xs font-semibold text-white">
                {([['all','오늘의 루틴',stats.total],['done','체크 완료',activity.rows.filter(row=>row.child_reported||row.verification_status==='CONFIRMED').length],['open','미체크',stats.missing]] as const).map(([key,label,count])=><button key={key} type="button" onClick={()=>setFilter(key)} aria-pressed={filter===key} className={`rounded-full px-2 py-3 ${filter===key?'bg-[#4d2ddc]':'text-white/70'}`}>{label}<span className="ml-1">{count}</span></button>)}
              </div>
              <p className="my-4 text-xs leading-5 text-[#737670]">체크는 내가 했다고 알려주는 기록이에요. 부모 확인 전에는 유보되며, 체크가 없다고 시간을 빼앗지 않아요.</p>
              {stats.missing>0 && !activity.loading && <div role="status" className="mb-4 rounded-2xl border border-[#dad3bd] bg-[#f0ebdc] p-4 text-xs leading-5 text-[#625a40]">아직 체크하지 않은 할 일이 {stats.missing}개 있어요. 했다면 알려주고, 기억나지 않으면 부모에게 확인을 부탁해요. 미확인은 패널티가 아니에요.</div>}
              <ChildActivityList emptyMessage={filter==="done"?"아직 체크 완료한 할 일이 없어요.":filter==="open"?"체크하지 않은 할 일이 없어요.":undefined} rows={visibleRows} loading={activity.loading} error={activity.error} reporting={activity.reporting} onReport={row=>void activity.report(row)} onRefresh={()=>void activity.refresh()} />
            </section>
            <section className="mt-10 pb-4">
              <div className="flex items-end gap-2"><h2 className="text-2xl font-bold tracking-[-0.05em] text-[#333a44]">부모 확인 진행률</h2><strong className="pb-0.5 text-xl text-[#4d2ddc]">{stats.total?Math.round(stats.confirmed/stats.total*100):0}%</strong></div>
              {Object.entries(activityCategoryLabels).map(([code,label])=>{
                const items=activity.rows.filter(row=>row.category_code===code); const done=items.filter(row=>row.verification_status==='CONFIRMED').length;
                if(!items.length)return null;
                return <div key={code} className="mt-6"><div className="mb-2 flex justify-between text-sm font-semibold"><span>{label}</span><span className="text-[#777a74]">{done} / {items.length}</span></div><div className="h-3.5 overflow-hidden rounded-full bg-[#ebe7de]"><div className="h-full rounded-full bg-[#4d2ddc]" style={{width:`${done/items.length*100}%`}} /></div></div>;
              })}
            </section>
          </>
        ) : (
          activeTab === "profile" ? <section className="mt-16 rounded-[28px] bg-white p-8 text-center">
            <UserRound className="mx-auto h-8 w-8 text-[#4d2ddc]"/><h2 className="mt-5 text-xl font-bold">나의 프로필</h2>
            <div className="mt-6 flex flex-col gap-3"><Button onClick={() => inputRef.current?.click()} disabled={uploading} className="bg-[#4d2ddc] text-white"><Camera className="h-4 w-4" /> 프로필 사진 등록·변경</Button><Button variant="outline" onClick={onLogout}><LogOut className="h-4 w-4" /> 로그아웃</Button></div>
          </section> : <section className="mt-10 space-y-4">
            <h2 className="text-2xl font-bold">{activeTab==='calendar'?'날짜별 할 일':'나의 확인 기록'}</h2>
            <label className="block text-sm font-semibold" htmlFor="child-activity-date">수행 날짜</label><input id="child-activity-date" type="date" value={day} max={today} onChange={e=>{if(e.target.value&&e.target.value<=today)setDay(e.target.value);}} className="w-full rounded-xl border border-black/10 bg-white px-4 py-3"/>
            <p className="text-xs leading-5 text-[#737670]">지나간 날짜의 체크도 해당 수행일로 남겨요. 부모가 확인한 예정분은 정산 전이며 사용 가능 잔액이 아니에요.</p>
            <ChildActivityList rows={activity.rows} loading={activity.loading} error={activity.error} reporting={activity.reporting} onReport={row=>void activity.report(row)} onRefresh={()=>void activity.refresh()}/>
          </section>
        )}

        <nav className="fixed bottom-[max(10px,env(safe-area-inset-bottom))] left-1/2 z-40 grid h-[52px] w-[calc(100%-24px)] max-w-[404px] -translate-x-1/2 grid-cols-4 rounded-[30px] bg-black px-4 shadow-[0_14px_35px_rgba(0,0,0,.28)]">
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

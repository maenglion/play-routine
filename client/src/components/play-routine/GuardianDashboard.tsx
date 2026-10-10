import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import { CircleAlert, Eye, Loader2, LogOut, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export type GuardianFamily = {
  id: string;
  /** Optional because guardians receive the authoritative family name only in the status RPC. */
  name?: string | null;
  timezone?: string | null;
} | null;

export type GuardianStatus = {
  family_name: string;
  child_display_name: string | null;
  child_avatar_url: string | null;
  child_status: "ACTIVE" | null;
  current_score: number | null;
  score_availability: "UNAVAILABLE_LEDGER_ABSENT";
};

export type GuardianDashboardProps = {
  session: Session;
  family: GuardianFamily;
  onLogout: () => void | Promise<void>;
};

/** View-only guardian home. Its sole data source is guardian_family_status RPC. */
export default function GuardianDashboard({ session, family, onLogout }: GuardianDashboardProps) {
  const [rows, setRows] = useState<GuardianStatus[]>([]);
  const [loading, setLoading] = useState(Boolean(family?.id));
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!family?.id) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.rpc("guardian_family_status", { p_family_id: family.id });
    setLoading(false);
    if (error) {
      setRows([]);
      setError("상태를 불러올 수 없습니다. 보호자 권한이 유지되는지 확인해 주세요.");
      return;
    }
    setRows((data ?? []) as GuardianStatus[]);
  }, [family?.id]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const guardianName = String(session.user.user_metadata?.display_name ?? session.user.email ?? "보호자");
  const activeChildren = rows.filter(row => row.child_display_name && row.child_status === "ACTIVE");

  return (
    <div className="min-h-dvh bg-[#f9f6ef] text-[#1a1a18]">
      <header className="border-b border-black/8 bg-[#333a44] text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Guardian view only</p>
            <h1 className="mt-1 text-xl font-bold tracking-[-0.03em]">{rows[0]?.family_name ?? family?.name ?? "보호자 상태판"}</h1>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void onLogout()} className="text-white hover:bg-white/10 hover:text-white" aria-label="로그아웃">
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
        <section className="rounded-[28px] bg-[#d4cfe7] p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-[#51447f]"><Eye className="h-4 w-4" /> 보기 전용</div>
              <h2 className="mt-3 text-2xl font-bold tracking-[-0.04em]">안녕하세요, {guardianName}님</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#51447f]">자녀의 현재 연결 상태만 확인할 수 있습니다. 루틴·규칙·프로필·기록은 변경하거나 다운로드할 수 없습니다.</p>
            </div>
            <Button variant="outline" size="icon" onClick={() => void loadStatus()} disabled={loading || !family} aria-label="상태 새로고침" className="shrink-0 bg-white/60">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </section>

        <section className="mt-7 rounded-[28px] bg-white p-6 shadow-[0_16px_48px_rgba(51,58,68,.08)] sm:p-8">
          <div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-[#4d2ddc]" /><h2 className="text-xl font-bold tracking-[-0.03em]">현재 연결 상태</h2></div>
          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-[#777a74]"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 상태를 불러오는 중</div>
          ) : error ? (
            <div role="alert" className="mt-6 flex gap-3 rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-900"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>
          ) : activeChildren.length === 0 ? (
            <div className="mt-6 rounded-2xl bg-[#f5f3ed] px-4 py-8 text-center text-sm leading-6 text-[#777a74]">현재 연결된 자녀 상태가 없습니다.</div>
          ) : (
            <div className="mt-6 space-y-3">
              {activeChildren.map((child, index) => (
                <article key={`${child.child_display_name}-${index}`} className="flex items-center gap-4 rounded-2xl border border-black/8 p-4 sm:p-5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#cde5de] text-base font-bold text-[#315f4d]">
                    {child.child_avatar_url ? <img src={child.child_avatar_url} alt="" className="h-full w-full object-cover" /> : child.child_display_name?.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold">{child.child_display_name}</h3>
                    <p className="mt-1 text-sm text-[#737670]">계정 연결됨</p>
                  </div>
                  <span className="rounded-full bg-[#e4f1eb] px-2.5 py-1 text-[10px] font-bold text-[#315f4d]">ACTIVE</span>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="mt-6 rounded-[24px] border border-[#d5d1c7] bg-[#eeeae1] p-5 text-sm leading-6 text-[#60635d]">
          <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#4d2ddc]" /><p><strong className="text-[#333a44]">점수는 아직 제공되지 않습니다.</strong> 현재 원장(ledger)이 없어 점수 값은 의도적으로 비워 두었습니다. 이 상태판은 점수·상세 기록·규칙을 조회하지 않습니다.</p></div>
        </section>
      </main>
    </div>
  );
}

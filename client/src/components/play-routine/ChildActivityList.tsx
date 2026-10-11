import { Button } from "@/components/ui/button";
import { Check, Clock3, Loader2, RefreshCw } from "lucide-react";
import type { ActivityDayRow } from "@/lib/activity-flow";

export const activityCategoryLabels:Record<string,string>={DAILY_STUDY:'매일공부',SPECIAL_SCHEDULE:'특별과제',LIFE_HABIT:'생활습관',OTHER:'기타'};
export default function ChildActivityList({rows,loading,error,reporting,onReport,onRefresh,emptyMessage}:{rows:ActivityDayRow[];loading:boolean;error:string|null;reporting:string|null;onReport:(row:ActivityDayRow)=>void;onRefresh:()=>void;emptyMessage?:string}) {
 if(loading)return <p className="flex min-h-32 items-center justify-center text-sm text-[#777a74]"><Loader2 className="mr-2 h-4 w-4 animate-spin"/>할 일을 불러오는 중</p>;
 if(error)return <div role="alert" className="rounded-2xl bg-red-50 p-4 text-sm text-red-800">{error}<Button variant="ghost" onClick={onRefresh} className="mt-2"><RefreshCw className="h-4 w-4"/>새로고침</Button></div>;
 if(!rows.length)return <div className="rounded-2xl bg-white px-5 py-7 text-sm leading-6 text-[#737670]">{emptyMessage??<>이 날짜에 배정된 할 일이 없어요.<br/>부모가 규칙을 게시하고 나에게 배정하면 보여요.</>}</div>;
 return <div className="space-y-3">{rows.map(row=>{
  const confirmed=row.verification_status==='CONFIRMED';const held=row.verification_status==='HELD';
  const isPassRule=row.measurement_kind==='PASS_FAIL';
  const passConfirmed=isPassRule&&row.parent_score===100;
  return <article key={row.occurrence_id} className={`rounded-2xl p-5 ${row.category_code==='LIFE_HABIT'?'bg-[#cde5de]':row.category_code==='SPECIAL_SCHEDULE'?'bg-[#eeeae1]':'bg-[#d4cfe7]'}`}>
   <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-semibold">{activityCategoryLabels[row.category_code]??'할 일'}</p><span className="rounded-full bg-white/60 px-2.5 py-1 text-[10px] font-bold">{confirmed?'부모 확인 완료':held?'부모 확인 대기':'아직 체크 안 됨'}</span></div>
   <h3 className="mt-2 text-lg font-bold leading-snug tracking-[-0.04em]">{row.activity_name}</h3>
   {row.description&&<p className="mt-2 whitespace-pre-line text-xs leading-5 text-[#525750]">{row.description}</p>}
   <p className="mt-3 text-xs leading-5 text-[#525750]">확인 기준: {row.metric_label}</p>
   {confirmed?<div className="mt-4 rounded-xl bg-white/65 p-3 text-xs leading-5"><strong>{isPassRule?(passConfirmed?`문제없음 PASS · +${row.confirmed_minutes??row.reward_minutes}분 예정`:'확인 필요 · 보상 없음'):row.outcome_code==='REWARD'&&row.confirmed_minutes!=null?`보상 예정 +${row.confirmed_minutes}분`:row.outcome_code==='PENALTY'&&row.confirmed_minutes!=null?`부모 확인한 차감 예정 ${row.confirmed_minutes}분`:row.outcome_code==='NO_REWARD'?'보상·차감 없음':'결과 확인 필요'}</strong><p className="mt-1">{isPassRule?(passConfirmed?'부모가 그날 문제없음을 확인했어요. 아직 정산 전이에요.':'문제가 있어 확인이 더 필요해요. 자동 패널티는 없어요.'):`부모 평가 ${row.parent_score} / 100 · 아직 정산 전이에요.`}</p>{row.parent_reason&&<p className="mt-2 whitespace-pre-line">확인 이유: {row.parent_reason}</p>}{row.parent_verified_at&&<p className="mt-1 text-[#737670]">확인 시각: {new Date(row.parent_verified_at).toLocaleString('ko-KR')}</p>}</div>:<span className="mt-4 inline-flex items-center gap-1 rounded-full bg-[#333a44] px-2.5 py-1 text-[11px] font-semibold text-white"><Clock3 className="h-3.5 w-3.5"/>{isPassRule?'부모 확인 전 · 아직 PASS가 아니에요':'기준 충족·부모 확인 시 +'+row.reward_minutes+'분 예정'}</span>}
   <Button className={`mt-4 w-full rounded-xl ${confirmed||row.child_reported?'bg-white/60 text-[#333a44]':'bg-[#4d2ddc] text-white hover:bg-[#3c20c7]'}`} disabled={Boolean(reporting)||confirmed||row.child_reported} onClick={()=>onReport(row)}>
    {reporting===row.occurrence_id?<Loader2 className="h-4 w-4 animate-spin"/>:<Check className="h-4 w-4"/>}{confirmed?'확인 완료':row.child_reported?'했다고 알려주었어요':'했어요'}
   </Button>
  </article>;
 })}</div>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { ActivityDayRow } from "@/lib/activity-flow";
import { toast } from "sonner";

export function useActivityDay(childId: string | undefined, date: string, preview = false) {
  const [rows, setRows] = useState<ActivityDayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const keys = useRef(new Map<string, string>());
  const target = useRef(`${childId}:${date}`);
  target.current = `${childId}:${date}`;
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!childId) { setRows([]); setLoading(false); return; }
    setLoading(true); setError(null);
    if (preview) {
      setRows([
        {occurrence_id:'preview-one',assignment_id:'preview-a',policy_rule_id:'preview-r',business_date:date,activity_name:'수학 문제 풀기',description:'문제를 풀고 부모에게 확인을 부탁해요.',category_code:'DAILY_STUDY',metric_label:'부모가 채점한 정답률',reward_minutes:30,penalty_minutes:0,child_reported:false,verification_status:'MISSING',parent_score:null,outcome_code:null,confirmed_minutes:null,revision:0},
        {occurrence_id:'preview-two',assignment_id:'preview-b',policy_rule_id:'preview-s',business_date:date,activity_name:'책상 정리하기',description:'물건을 제자리에 두고 알려 주세요.',category_code:'LIFE_HABIT',metric_label:'정리 완료율',reward_minutes:10,penalty_minutes:0,child_reported:true,verification_status:'HELD',parent_score:null,outcome_code:null,confirmed_minutes:null,revision:1},
      ]); setLoading(false); return;
    }
    try {
      const { data, error } = await supabase.rpc('list_activity_day', {p_child_profile_id:childId,p_business_date:date});
      if (request !== generation.current) return;
      if (error) throw error;
      setRows((data ?? []) as ActivityDayRow[]);
    } catch { if (request === generation.current) { setRows([]); setError('할 일을 불러오지 못했어요. 새로고침해 주세요.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [childId,date,preview]);
  useEffect(() => { setRows([]); void load(); return () => {generation.current++;}; }, [load]);
  useEffect(() => { const refresh = () => {void load();}; window.addEventListener('focus',refresh); return () => window.removeEventListener('focus',refresh); }, [load]);
  const report = async (row: ActivityDayRow) => {
    if (submitting.current || row.child_reported || row.verification_status === 'CONFIRMED') return;
    if (preview) {
      setRows(old=>old.map(item=>item.occurrence_id===row.occurrence_id?{...item,child_reported:true,verification_status:'HELD',revision:item.revision+1}:item));
      toast.info('미리보기 체크입니다. 실제 기록은 저장하지 않았어요.'); return;
    }
    submitting.current=true; setReporting(row.occurrence_id);
    const reportTarget = target.current;
    const key=keys.current.get(row.occurrence_id)??crypto.randomUUID(); keys.current.set(row.occurrence_id,key);
    try {
      const {error}=await supabase.rpc('report_activity_done',{p_occurrence_id:row.occurrence_id,p_idempotency_key:key,p_occurred_at:null});
      if(error)throw error;
      keys.current.delete(row.occurrence_id);
      toast.success('했다고 알려주었어요. 부모 확인을 기다려요.');
      if (reportTarget === target.current) await load();
    } catch { toast.error('체크를 저장하지 못했어요. 같은 버튼으로 다시 시도해 주세요.'); }
    finally {submitting.current=false;setReporting(null);}
  };
  return {rows,loading,error,reporting,refresh:load,report};
}

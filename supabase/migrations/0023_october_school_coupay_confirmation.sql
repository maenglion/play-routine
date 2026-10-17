begin;
-- 이미 설치된 0021/0022, 규칙 버전, 채택/발생/학교 bucket의 정체성을 변경하지 않는다.
-- 사전 정의된 두 자산 분기 중 부모가 승인한 쿠페이를 한 번 선택한다. 자동 마감·권리발행·이행 없음.
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists public.october_school_asset_decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  plan_id uuid not null,
  prior_asset public.october_school_asset not null check(prior_asset='PENDING'),
  school_asset public.october_school_asset not null check(school_asset='COUPAY_KRW'),
  decision_code text not null check(decision_code='SCHOOL_COUPAY_CONFIRMATION_20261018'),
  authorized_by_principal_id uuid not null references public.principals(id) on delete restrict,
  source_snapshot jsonb not null,
  recorded_at timestamptz not null default now(),
  unique(plan_id), unique(id,family_id),
  foreign key(plan_id,family_id) references public.october_plans(id,family_id) on delete restrict,
  check(jsonb_typeof(source_snapshot)='object' and octet_length(source_snapshot::text)<=2048)
);
alter table public.october_school_asset_decisions enable row level security;
revoke all on table public.october_school_asset_decisions from public,anon,authenticated,service_role;
create policy october_school_asset_decisions_no_direct_access on public.october_school_asset_decisions
  for all to anon,authenticated using(false) with check(false);

create or replace function private.october_guard_school_asset_decision()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' and current_setting('private.october_school_decision_write',true)='on' then return new; end if;
  raise exception 'OCTOBER_SCHOOL_DECISION_APPEND_ONLY' using errcode='55000';
end $$;
revoke all on function private.october_guard_school_asset_decision() from public,anon,authenticated,service_role;
create trigger october_school_asset_decision_guard before insert or update or delete on public.october_school_asset_decisions
for each row execute function private.october_guard_school_asset_decision();
create trigger october_school_asset_decision_no_truncate before truncate on public.october_school_asset_decisions
for each statement execute function play_audit.prevent_event_mutation();

create or replace function play_audit.capture_october_school_asset_decision()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_safe jsonb; v_auth uuid:=auth.uid(); v_principal uuid;
begin
  if tg_op<>'INSERT' or tg_table_schema<>'public' or tg_table_name<>'october_school_asset_decisions' then
    raise exception 'OCTOBER_SCHOOL_DECISION_AUDIT_CONTEXT' using errcode='55000'; end if;
  select id into v_principal from public.principals where auth_user_id=v_auth;
  v_safe:=jsonb_build_object('id',new.id,'family_id',new.family_id,'plan_id',new.plan_id,
    'prior_asset',new.prior_asset::text,'school_asset',new.school_asset::text,'decision_code',new.decision_code,
    'authorized_by_principal_id',new.authorized_by_principal_id,'recorded_at',new.recorded_at);
  insert into play_audit.events(family_id,table_schema,table_name,row_id,operation,transaction_id,
    actor_auth_user_id,actor_principal_id,actor_kind,db_session_user,jwt_role,changed_columns,new_values,new_fingerprint)
  values(new.family_id,'public','october_school_asset_decisions',new.id,'INSERT',pg_current_xact_id()::text,
    v_auth,v_principal,case when v_auth is null then 'DATABASE_SESSION' else 'AUTH_USER' end,
    session_user::text,auth.role(),array['id','family_id','plan_id','prior_asset','school_asset','decision_code','authorized_by_principal_id','recorded_at'],
    v_safe,encode(sha256(convert_to(v_safe::text,'UTF8')),'hex'));
  return null;
end $$;
revoke all on function play_audit.capture_october_school_asset_decision() from public,anon,authenticated,service_role;
create trigger play_audit_october_school_asset_decision after insert on public.october_school_asset_decisions
for each row execute function play_audit.capture_october_school_asset_decision();

-- 관리자용 한정 처리. 클라이언트에 공개하지 않으며 승인 대상 부모와 실제 DB 관리 실행을 구별한다.
create or replace function private.apply_october_school_coupay_confirmation(p_plan_id uuid,p_authorizing_parent uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.october_plans%rowtype; d public.october_school_asset_decisions%rowtype;
  s public.october_plan_adoptions%rowtype; r public.october_rule_versions%rowtype;
  prior_setting text:=coalesce(current_setting('private.october_seed_write',true),'off');
begin
  select * into p from public.october_plans where id=p_plan_id for update;
  if p.id is null or p.status<>'ACTIVE' or p.month<>date '2026-10-01'
    or private.october_actor_is_verified_parent(p_authorizing_parent,p.family_id) is distinct from true then
    raise exception 'OCTOBER_SCHOOL_DECISION_TARGET_INVALID' using errcode='42501'; end if;
  select a.* into s from public.october_plan_adoptions a
  join public.october_rule_versions rv on rv.id=a.rule_version_id and rv.family_id=a.family_id
  join public.october_rule_identities i on i.id=rv.rule_identity_id and i.family_id=rv.family_id
  where a.plan_id=p.id and a.family_id=p.family_id and i.stable_code='T-007' order by a.id limit 1;
  select * into r from public.october_rule_versions where id=s.rule_version_id and family_id=p.family_id;
  if s.id is null or r.condition_spec->'tiers'->'COUPAY_KRW' is distinct from '[{"min":5,"quantity":10000},{"min":8,"quantity":15000}]'::jsonb then
    raise exception 'OCTOBER_SCHOOL_COUPAY_TIERS_MISMATCH' using errcode='22023'; end if;
  select * into d from public.october_school_asset_decisions where plan_id=p.id;
  if d.id is not null then
    if p.school_asset<>'COUPAY_KRW' or d.school_asset<>'COUPAY_KRW' or d.authorized_by_principal_id<>p_authorizing_parent then
      raise exception 'OCTOBER_SCHOOL_DECISION_REPLAY_MISMATCH' using errcode='22023'; end if;
    return jsonb_build_object('inserted',false,'school_asset','COUPAY_KRW','rights_issued',0);
  end if;
  if p.school_asset<>'PENDING' then raise exception 'OCTOBER_SCHOOL_DECISION_ALREADY_SET' using errcode='22023'; end if;
  if exists(select 1 from public.october_rights x join public.october_rule_versions rv on rv.id=x.rule_version_id
    join public.october_rule_identities i on i.id=rv.rule_identity_id where x.family_id=p.family_id and i.stable_code='T-007') then
    raise exception 'OCTOBER_SCHOOL_EXISTING_RIGHT_REQUIRES_REVIEW' using errcode='22023'; end if;
  perform set_config('private.october_school_decision_write','on',true);
  insert into public.october_school_asset_decisions(family_id,plan_id,prior_asset,school_asset,decision_code,authorized_by_principal_id,source_snapshot)
  values(p.family_id,p.id,'PENDING','COUPAY_KRW','SCHOOL_COUPAY_CONFIRMATION_20261018',p_authorizing_parent,
    jsonb_build_object('source','사용자 메시지 2026-10-18 02:55:01 Asia/Seoul',
      'statement','기존 확정 유지: 쿠페이머니 10,000원 / 15,000원',
      'mode','HIGHEST_MATCH_FINAL_TOTAL','tiers',r.condition_spec->'tiers'->'COUPAY_KRW',
      'plan_effective_from',p.effective_from,'plan_effective_to',p.effective_to));
  perform set_config('private.october_school_decision_write','off',true);
  perform set_config('private.october_seed_write','on',true);
  update public.october_plans set school_asset='COUPAY_KRW' where id=p.id;
  perform set_config('private.october_seed_write',prior_setting,true);
  return jsonb_build_object('inserted',true,'school_asset','COUPAY_KRW','rights_issued',0);
end $$;
revoke all on function private.apply_october_school_coupay_confirmation(uuid,uuid) from public,anon,authenticated,service_role;

-- 원본 get_october_board를 private로 보존하고 화면 projection만 보강한다.
-- 규칙/version/채택/원사건/학교기간 정본은 재작성하지 않는다.
alter function public.get_october_board(uuid,uuid,date) set schema private;
alter function private.get_october_board(uuid,uuid,date) rename to october_board_before_school_confirmation;
revoke all on function private.october_board_before_school_confirmation(uuid,uuid,date) from public,anon,authenticated,service_role;
create or replace function public.get_october_board(p_family_id uuid,p_child_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b jsonb; rules jsonb; asset text;
begin
  b:=private.october_board_before_school_confirmation(p_family_id,p_child_id,p_date);
  asset:=b->'plan'->>'school_asset';
  if asset is not null and asset<>'PENDING' then
    select coalesce(jsonb_agg(case when rule->>'code'='T-007' then
      jsonb_set(jsonb_set(rule,'{pending_fields}',coalesce((select jsonb_agg(x) from jsonb_array_elements_text(rule->'pending_fields') x where x not like '%자산 최신 확인%'),'[]'::jsonb)),
        '{condition_spec,school_asset}',to_jsonb(asset)) else rule end order by rule->>'code'),'[]'::jsonb)
    into rules from jsonb_array_elements(b->'rules') rule;
    b:=jsonb_set(b,'{rules}',rules);
  end if;
  return b;
end $$;
revoke all on function public.get_october_board(uuid,uuid,date) from public,anon,authenticated,service_role;
grant execute on function public.get_october_board(uuid,uuid,date) to authenticated;
notify pgrst,'reload schema';
commit;

begin;
-- Play Routine / Supabase PostgreSQL 감사로그 v0.1
-- 전제: 현행 public 스키마의 migration 0001~0019가 설치된 프로젝트.
-- 실행 위치: 해당 프로젝트 SQL Editor, 관리자(postgres) 권한.
-- 이 파일은 실제 객체를 생성하고 COMMIT한다. 작성·검증만으로 운영에 적용되지 않는다.
-- 기존 데이터를 초기화·삭제·백필하지 않으며, 설치 이후 성공한 행 변경만 기록한다.
-- 원본 테이블 권한·기존 트리거·보상 계산은 변경하지 않는다.
-- SELECT/DDL/권한 거절/rollback된 요청은 이 행 트리거의 기록 범위가 아니다.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. 오타 또는 다른 프로젝트 스키마에서 조용히 일부 설치되지 않게 전제 검사.
do $preflight$
declare
  v_table text;
  v_columns text[];
begin
  if to_regclass('public.principals') is null
     or to_regclass('public.family_memberships') is null
     or to_regclass('public.families') is null
     or to_regprocedure('auth.uid()') is null
     or to_regprocedure('auth.role()') is null then
    raise exception 'AUDIT_PREREQUISITES_MISSING' using errcode = '55000';
  end if;
  foreach v_table in array array[
    'family_memberships', 'child_profiles',
    'manual_money_rewards', 'manual_bonus_coupons', 'manual_reward_events',
    'routine_reinforcers', 'routine_drafts', 'routine_rules',
    'routine_conditions', 'routine_reward_items', 'routine_assignments',
    'routine_assignment_end_events', 'routine_occurrences',
    'routine_occurrence_events', 'routine_entitlements', 'routine_entitlement_events'
  ] loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise exception 'AUDIT_TARGET_MISSING: %', v_table using errcode = '55000';
    end if;
    select array_agg(a.attname::text order by a.attname)
    into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = to_regclass(format('public.%I', v_table))
      and a.attnum > 0 and not a.attisdropped
      and a.attname in ('id', 'family_id') and a.atttypid = 'uuid'::regtype;
    if v_columns is distinct from array['family_id', 'id']::text[] then
      raise exception 'AUDIT_TARGET_KEYS_MISMATCH: %', v_table using errcode = '55000';
    end if;
  end loop;
end;
$preflight$;

-- 2. REST 공개 스키마에 추가하지 않는 전용 영역.
create schema if not exists play_audit;
revoke all on schema play_audit from public, anon, authenticated, service_role;

create table if not exists play_audit.events (
  audit_id bigint generated always as identity primary key,
  family_id uuid not null references public.families(id) on delete restrict,
  table_schema text not null check (table_schema = 'public'),
  table_name text not null,
  row_id uuid not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  occurred_at timestamptz not null default clock_timestamp(),
  statement_started_at timestamptz not null default statement_timestamp(),
  transaction_started_at timestamptz not null default transaction_timestamp(),
  transaction_id text not null,
  actor_auth_user_id uuid,
  actor_principal_id uuid,
  actor_kind text not null check (actor_kind in ('AUTH_USER', 'DATABASE_SESSION')),
  db_session_user text not null,
  jwt_role text,
  changed_columns text[] not null default '{}',
  old_values jsonb,
  new_values jsonb,
  old_fingerprint text,
  new_fingerprint text,
  format_version integer not null default 1 check (format_version = 1),
  check (old_values is null or jsonb_typeof(old_values) = 'object'),
  check (new_values is null or jsonb_typeof(new_values) = 'object'),
  check (old_fingerprint is null or old_fingerprint ~ '^[0-9a-f]{64}$'),
  check (new_fingerprint is null or new_fingerprint ~ '^[0-9a-f]{64}$'),
  check ((operation = 'INSERT' and old_values is null and new_values is not null)
      or (operation = 'DELETE' and old_values is not null and new_values is null)
      or (operation = 'UPDATE' and old_values is not null and new_values is not null))
);
-- 행위자 ID는 당시 식별자의 사본이다. Auth 계정 삭제에 따른 연쇄 삭제를 만들지 않는다.
-- family_id는 기존 가족 정체성을 보존하는 FK이며 가족 물리 삭제를 제한한다.
-- fingerprint는 허용 필드 사본의 SHA-256이다. 원문 전체 또는 hash chain이 아니다.

create index if not exists play_audit_events_family_cursor_idx
  on play_audit.events (family_id, audit_id desc);
create index if not exists play_audit_events_row_idx
  on play_audit.events (family_id, table_name, row_id, audit_id desc);
create index if not exists play_audit_events_transaction_idx
  on play_audit.events (transaction_id, audit_id);

alter table play_audit.events enable row level security;
revoke all on table play_audit.events from public, anon, authenticated, service_role;
revoke all on sequence play_audit.events_audit_id_seq from public, anon, authenticated, service_role;
drop policy if exists play_audit_no_direct_client_access on play_audit.events;
create policy play_audit_no_direct_client_access on play_audit.events
  for all to anon, authenticated using (false) with check (false);

-- 3. 감사 원본 자체의 UPDATE/DELETE/TRUNCATE를 명시적으로 거절.
-- 관리자도 정상 DML은 거절된다. 다만 소유자/관리자는 트리거를 끌 수 있다.
create or replace function play_audit.prevent_event_mutation()
returns trigger language plpgsql set search_path = '' as $function$
begin
  raise exception 'AUDIT_APPEND_ONLY' using errcode = '55000';
end;
$function$;
revoke all on function play_audit.prevent_event_mutation() from public, anon, authenticated, service_role;

drop trigger if exists play_audit_events_no_mutation on play_audit.events;
create trigger play_audit_events_no_mutation
  before update or delete on play_audit.events
  for each row execute function play_audit.prevent_event_mutation();
drop trigger if exists play_audit_events_no_truncate on play_audit.events;
create trigger play_audit_events_no_truncate
  before truncate on play_audit.events
  for each statement execute function play_audit.prevent_event_mutation();

-- 4. 전체 OLD/NEW JSON을 복사하지 않고 테이블별 허용 필드만 남긴다.
-- payload·request_payload·reason·parent_reason·이름·자유서술·의료기록 제외.
-- changed_columns에는 변경한 열 이름만 남는다. 숨긴 열의 원문/해시는 보관하지 않는다.
create or replace function play_audit.capture_row_change()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_old_safe jsonb;
  v_new_safe jsonb;
  v_columns text[];
  v_changed text[];
  v_family uuid;
  v_row_id uuid;
  v_auth_user uuid := auth.uid();
  v_principal uuid;
begin
  if tg_table_schema <> 'public' or tg_level <> 'ROW'
     or tg_when <> 'AFTER' or tg_op not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'AUDIT_TRIGGER_CONTEXT_INVALID' using errcode = '55000';
  end if;

  v_columns := case tg_table_name
    when 'family_memberships' then array['id','family_id','principal_id','role','status','valid_from','valid_to','created_by_principal_id','ended_by_principal_id','created_at','updated_at']
    when 'child_profiles' then array['id','family_id','principal_id','status','created_by_principal_id','created_at','updated_at','linked_at','unlinked_at']
    when 'manual_money_rewards' then array['id','family_id','child_profile_id','reward_kind','period_start','period_end','status','planned_amount_krw','created_by_principal_id','created_at','paid_by_principal_id','paid_at','paid_on','voided_by_principal_id','voided_at']
    when 'manual_bonus_coupons' then array['id','family_id','child_profile_id','unit','amount','issued_on','status','issued_by_principal_id','issued_at','redeemed_by_principal_id','redeemed_at','voided_by_principal_id','voided_at']
    when 'manual_reward_events' then array['id','family_id','money_reward_id','bonus_coupon_id','actor_principal_id','event_kind','recorded_at']
    when 'routine_reinforcers' then array['id','family_id','unit','created_by_principal_id','created_at']
    when 'routine_drafts' then array['id','family_id','source_rule_id','step','revision','status','published_rule_id','effective_from','created_by_principal_id','created_at','updated_at']
    when 'routine_rules' then array['id','family_id','subject_ref_id','source_rule_id','rule_group_id','category_code','flow','measurement','period','effective_from','version','published_by_principal_id','published_at']
    when 'routine_conditions' then array['id','family_id','rule_id','source_tier_id','tier_no','threshold','operator','created_at']
    when 'routine_reward_items' then array['id','family_id','condition_id','source_reward_id','reinforcer_id','unit_snapshot','amount','created_at']
    when 'routine_assignments' then array['id','family_id','rule_id','child_profile_id','starts_on','ends_on','weekdays','repeat_kind','created_by_principal_id','created_at']
    when 'routine_assignment_end_events' then array['id','family_id','assignment_id','actor_principal_id','prior_ends_on','ends_on','recorded_at']
    when 'routine_occurrences' then array['id','family_id','child_profile_id','assignment_id','rule_id','business_date','materialized_at','child_reported_at','parent_verified_at','score','pass','praise','stickers','current_revision']
    when 'routine_occurrence_events' then array['id','family_id','occurrence_id','actor_principal_id','event_kind','expected_revision','score','pass','praise','stickers','recorded_at']
    when 'routine_entitlements' then array['id','family_id','child_profile_id','rule_id','condition_id','reward_item_id','source_occurrence_id','source_date','period_start','period_end','status','requires_review','created_by_principal_id','created_at','fulfilled_by_principal_id','fulfilled_at']
    when 'routine_entitlement_events' then array['id','family_id','entitlement_id','actor_principal_id','event_kind','recorded_at']
    else null end;
  if v_columns is null then
    raise exception 'AUDIT_TABLE_NOT_ALLOWED' using errcode = '55000';
  end if;

  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and v_old = v_new then return null; end if;
  if tg_op = 'UPDATE' and
      (v_old->'id' is distinct from v_new->'id'
       or v_old->'family_id' is distinct from v_new->'family_id') then
    raise exception 'AUDIT_IDENTITY_CHANGE_FORBIDDEN' using errcode = '55000';
  end if;
  v_row := coalesce(v_new, v_old);
  v_family := (v_row->>'family_id')::uuid;
  v_row_id := (v_row->>'id')::uuid;
  if v_family is null or v_row_id is null then
    raise exception 'AUDIT_TARGET_ID_REQUIRED' using errcode = '55000';
  end if;

  -- 가변 행 데이터의 actor_principal_id는 신원 증거로 신뢰하지 않는다.
  -- JWT 주체에서 행위자를 계산하고 DB 세션 주체도 함께 보관한다.
  select p.id into v_principal from public.principals p
  where p.auth_user_id = v_auth_user;

  select coalesce(array_agg(k order by k), '{}'::text[]) into v_changed
  from (
    select jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) as k
    union
    select jsonb_object_keys(coalesce(v_new, '{}'::jsonb)) as k
  ) keys
  where v_old->k is distinct from v_new->k;
  if v_old is not null then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    into v_old_safe from jsonb_each(v_old) e where e.key = any(v_columns);
  end if;
  if v_new is not null then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    into v_new_safe from jsonb_each(v_new) e where e.key = any(v_columns);
  end if;

  insert into play_audit.events (
    family_id, table_schema, table_name, row_id, operation, transaction_id,
    actor_auth_user_id, actor_principal_id, actor_kind, db_session_user, jwt_role,
    changed_columns, old_values, new_values, old_fingerprint, new_fingerprint
  ) values (
    v_family, tg_table_schema, tg_table_name, v_row_id, tg_op,
    pg_current_xact_id()::text, v_auth_user, v_principal,
    case when v_auth_user is null then 'DATABASE_SESSION' else 'AUTH_USER' end,
    session_user::text, auth.role(), v_changed, v_old_safe, v_new_safe,
    case when v_old_safe is null then null else encode(sha256(convert_to(v_old_safe::text, 'UTF8')), 'hex') end,
    case when v_new_safe is null then null else encode(sha256(convert_to(v_new_safe::text, 'UTF8')), 'hex') end
  );
  -- 예외를 무시하지 않는다. 감사 기록 실패 시 해당 업무 변경도 rollback된다.
  return null;
end;
$function$;
revoke all on function play_audit.capture_row_change() from public, anon, authenticated, service_role;

-- 5. 기존 트리거 이름과 충돌하지 않는 AFTER 트리거를 16개 테이블에 추가.
-- 동일 파일 재실행 시 이 파일의 트리거만 재생성하며 기존 감사행은 보존한다.
do $install$
declare v_table text;
begin
  foreach v_table in array array[
    'family_memberships', 'child_profiles',
    'manual_money_rewards', 'manual_bonus_coupons', 'manual_reward_events',
    'routine_reinforcers', 'routine_drafts', 'routine_rules',
    'routine_conditions', 'routine_reward_items', 'routine_assignments',
    'routine_assignment_end_events', 'routine_occurrences',
    'routine_occurrence_events', 'routine_entitlements', 'routine_entitlement_events'
  ] loop
    execute format('drop trigger if exists play_audit_row_change on public.%I', v_table);
    execute format('create trigger play_audit_row_change after insert or update or delete on public.%I for each row execute function play_audit.capture_row_change()', v_table);
  end loop;
end;
$install$;

-- 6. 부모만 자기 가족의 감사 기록을 읽는 RPC. 자녀·조회 보호자·다른 가족은 거절.
-- 세션 JWT, 활성/유효기간, 확인된 이메일, 활성 가족을 함께 확인한다.
-- private schema를 Supabase Exposed schemas에 추가할 필요가 없다.
create or replace function public.list_family_audit_events(
  p_family_id uuid,
  p_before_audit_id bigint default null,
  p_limit integer default 50
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.family_memberships fm
    join public.principals p on p.id = fm.principal_id
    join public.families f on f.id = fm.family_id
    join auth.users u on u.id = p.auth_user_id
    where fm.family_id = p_family_id and p.auth_user_id = auth.uid()
      and p.status = 'ACTIVE' and f.status = 'ACTIVE'
      and u.email_confirmed_at is not null
      and fm.role in ('OWNER_PARENT','PARENT') and fm.status = 'ACTIVE'
      and fm.valid_from <= statement_timestamp()
      and (fm.valid_to is null or fm.valid_to > statement_timestamp())
  ) then
    raise exception 'AUDIT_READ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100
     or (p_before_audit_id is not null and p_before_audit_id <= 0) then
    raise exception 'AUDIT_PAGE_INVALID' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(s.entry order by s.audit_id desc), '[]'::jsonb)
  into v_result
  from (
    select e.audit_id, jsonb_build_object(
      'audit_id', e.audit_id, 'family_id', e.family_id,
      'table_name', e.table_name, 'row_id', e.row_id, 'operation', e.operation,
      'occurred_at', e.occurred_at, 'transaction_id', e.transaction_id,
      'actor_principal_id', e.actor_principal_id, 'actor_kind', e.actor_kind,
      'changed_columns', e.changed_columns,
      'old_values', e.old_values, 'new_values', e.new_values,
      'old_fingerprint', e.old_fingerprint, 'new_fingerprint', e.new_fingerprint,
      'format_version', e.format_version
    ) as entry
    from play_audit.events e
    where e.family_id = p_family_id
      and (p_before_audit_id is null or e.audit_id < p_before_audit_id)
    order by e.audit_id desc limit p_limit
  ) s;
  return v_result;
end;
$function$;
revoke all on function public.list_family_audit_events(uuid, bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_family_audit_events(uuid, bigint, integer) to authenticated;

comment on table play_audit.events is '성공한 행 변경의 제한된 감사 사본. 기존 업무 사건·권한 거절·SELECT/DDL 로그·독립감사를 대체하지 않음.';
comment on column play_audit.events.audit_id is '발급 순서 커서. sequence 공백이 가능하며 커밋 시각의 완전한 순서가 아님.';
comment on column play_audit.events.old_fingerprint is '허용된 이전 필드 JSON의 SHA-256. 외부 체크포인트나 hash chain이 아니며 개인정보 익명화를 보증하지 않음.';
comment on column play_audit.events.new_fingerprint is '허용된 이후 필드 JSON의 SHA-256. 숨긴 payload·사유 원문의 해시는 저장하지 않음.';

notify pgrst, 'reload schema';
commit;

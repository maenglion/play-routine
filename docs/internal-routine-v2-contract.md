# Routine v2 구현 계약 (20261015-1)

공통 TypeScript: `shared/routine-v2.ts`. 이 파일의 JSON 필드명을 정확히 사용한다. 신규 모듈은 기존 0001~0016 스키마·함수·데이터를 변경하지 않으며 approved ref를 게시 때만 만들거나 재사용한다. 신규 migration 0017과 함수 routine_*를 사용한다. 기존 설정/과거 배정은 유지한다.

## RPC 반환

모든 list는 JSONB 배열, 단일 변경은 JSONB 단일 객체. Supabase `.rpc` data를 그대로 받는다 (table-return `[0]` 아님).

- `list_routine_reinforcers(p_family_id)` → ReinforcerRow[]. 부모만.
- `create_routine_reinforcer(p_family_id,p_name,p_unit,p_unit_label,p_idempotency_key)` → ReinforcerRow. 종류 WON/MIN/POINT/STRING, 이름·단위부모입력. 불변 카탈로그, 직접 table 접근 금지.
- `list_routine_registry(p_family_id)` → {drafts:RoutineDraftRow[],rules:RoutineRuleRow[]}.
- `save_routine_draft(p_family_id,p_draft_id uuid|null,p_source_rule_id uuid|null,p_step int,p_payload jsonb,p_expected_revision int,p_idempotency_key uuid)` → RoutineDraftRow. 새것 expected0, 수정 revision CAS. 이름/보상 없는 1단계 저장가능; 게시때 완성검증. 같은 idempotencykey+payload exactreplay safe.
- `publish_routine_draft(p_draft_id,p_expected_revision,p_idempotency_key)` → RoutineRuleRow. 입력엔 family 없고 draft로 실제소유권검증. 내일효력. 새게시원문 immutable, newversiondraft에 source_rule_id 보존. 최대2보상/조건, tiers1~5. 같은조건reward두번째필수아님. DAILY STICKER/GTE positiveinteger thresholds ascending;QUEST quantity|percent/GTE|GT 0~100 thresholds ascending, explicitneutralandlowerpenalty settings. 약절대excluded via policy no medicationfield.
- `create_routine_assignment(p_family_id,p_rule_id,p_child_profile_id,p_starts_on,p_ends_on date|null,p_weekdays int[],p_repeat DAILY|ONCE,p_idempotency_key)` → RoutineAssignmentRow. 내일이후, PUBLISHEDeff date, latest applicable group only, 동일activityref/child overlappingactualdate conflict.
- `list_routine_assignments(p_family_id)` → RoutineAssignmentRow[]. 부모.
- `end_routine_assignment(p_assignment_id,p_ends_on,p_idempotency_key)` → RoutineAssignmentRow.오늘이후 inclusive종료, 과거/다른필드rewrite금지audit.
- `list_routine_day(p_child_profile_id,p_business_date)` → RoutineDayRow[]. 부모or자녀self only, futuredenied, materializeonlyactiveassignmentsdate. 해당periodtiers inclreached status, reinforcement labels정본snapshot, parent 이유아이에게보임. hold stickersnull not0, sticker_total onlyverified. weekly Mon-Sun timezone, monthlycalendar. QUEST periodsource shouldindividualoccurrence, notmonthlygroupalltests. DAILY SPECIAL_EVENT onlyONCE schedule (simplest clear semantics).
- `report_routine_done(p_occurrence_id,p_expected_revision,p_idempotency_key)` → {ok:true}. 자녀self only, 부모확정지우지않음. revisionCAS; performedbusiness date serverbound nofreeeventdates.
- `verify_routine_occurrence(p_occurrence_id,p_score number|null,p_pass boolean|null,p_praise boolean,p_reason text,p_expected_revision int,p_idempotency_key uuid)` → {ok:true}. 부모only. DAILYpass1/praise+1, fail0(praise=false only), QUESTscorefinite0~100(passnull/praisefalse). revisionCAS. immutableevents; uniqueentitlementsperoriginitem. QUESTimmediatelycreateselectedtiersatomic; DAILYdon'tearlyissueweekly/monthly. 수정lowerresultafteraward -> reviewflag/preservefulfilled, never autoeraseactualpayment. Noactualledger.
- `confirm_routine_period(p_child_profile_id,p_rule_id,p_reference_date,p_idempotency_key)` → {ok:true,issued:number}. 부모only DAILY: require familytoday>period_end; gatherverifiedstickers andensureatleastone assignedoccurrence period; tiers>=thresholdemitallbaseandaddition exactlyonceperchildruleperiodtieritem. Nootheractivitiesmixed. Referenceexistingassigneddate, futuredenied. Usefulafterweekendwithno lastdayverify. Allperiodsclosed gate. Previousrewardgeneration sourceparentverification snapshot audit.
- `list_routine_entitlements(p_child_profile_id)` → RoutineEntitlementRow[]. parentorselfchild (guardianexcluded). Available entitlement NOT ledger. reviewfieldsifneeded canaddrequires_review:boolean optionaltoTS.
- `fulfill_routine_entitlement(p_entitlement_id,p_idempotency_key)` → {ok:true}. 부모only onceatomic AVAILABLE→FULFILLED, requires_review falseonly. Noautomatictransfer; actualoutsidepayment/useconfirmation. Currency/point/timeindependent.

## UI constraints

3stages wizard, eachstepdraftsaveandlistresume. tabReward/Penalty/Reinforcers onRegistry top. Penalty pane QUEST lowerLimit +0..240mincandidate only; DAILYnorulesofstickerforfeit. defaults noassumedmoney. Reinforcercatalog selection type immutable. Plussecond rewardbutton max2,removable. Additional tier threshold DAILYshowdelta+accumulative (storethresholdaccumulative),QUESTsinglecondition+optionaltier. step1childLabel<=20 visiblechars UI usingIntl.Segmenter, DB capchar_lengthreasonable graphemecodepoints. criteriarequiredpublish. Publishedmainbutton「内日」Korean내일부터게시, existinglegacyrules remainseparatecollapse section.

## test fixtures

Scripts use pg getSupabaseConnectionString, sharedadvisorytestlock(hashtextextended('play-routine-live-test-fixture',0)) consistentexisting scripts, rollback withalwaysfinally. No real user/child reward creation. Include grants/RLSanon/guardian/otherfamilydenied,draftpartialresumeCASidempotent,publishedimmutable,numeric >90 boundary, optional1/2reject3, daily1/2hold countunique,5/8base+extra,atomicentitlementsindependentfulfillment,closedweekgate,correctionaudit.

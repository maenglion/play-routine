import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUser:vi.fn(), query:vi.fn() }));
vi.mock("@supabase/supabase-js",()=>({createClient:()=>({auth:{getUser:mocks.getUser}})}));
vi.mock("pg",()=>({Pool:class {query=mocks.query;}}));
vi.mock("./supabaseConnection",()=>({getSupabaseConnectionString:()=>"postgresql://test@localhost/test"}));
import { OCTOBER_RECORD_CSV_COLUMNS, OCTOBER_RIGHT_CSV_COLUMNS, registerExportRoutes, toCsvWithColumns } from "./routes/exports";
let close:(()=>Promise<void>)|undefined;
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('SUPABASE_URL','https://example.supabase.co');vi.stubEnv('SUPABASE_PUBLISHABLE_KEY','test-only');});
afterEach(async()=>{await close?.();close=undefined;vi.unstubAllEnvs();});
async function request(dataset:string,familyId='00000000-0000-4000-8000-000000000001') {
 const app=express();registerExportRoutes(app);const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));close=()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
 const {port}=server.address() as AddressInfo;
 return fetch(`http://127.0.0.1:${port}/api/exports/family.csv?dataset=${dataset}&familyId=${familyId}`,{headers:{Authorization:'Bearer fake-test-token'}});
}
const verified=()=>({data:{user:{id:'test-auth-user',email_confirmed_at:'2026-10-10T00:00:00Z'}},error:null});
describe('활동 CSV 가족별 접근 보안',()=>{
 it('이메일 미확인 세션은 DB를 조회하지 않는다',async()=>{mocks.getUser.mockResolvedValue({data:{user:{id:'test-auth-user'}},error:null});const r=await request('activity-records');expect(r.status).toBe(401);expect(mocks.query).not.toHaveBeenCalled();});
 it('자녀·보기 전용 보호자·타가족은 부모 권한 조회에서 차단한다',async()=>{mocks.getUser.mockResolvedValue(verified());mocks.query.mockResolvedValue({rows:[]});const r=await request('activity-records');expect(r.status).toBe(403);expect(mocks.query).toHaveBeenCalledTimes(1);expect(mocks.query.mock.calls[0][0]).toContain("fm.role in ('OWNER_PARENT', 'PARENT')");expect(mocks.query.mock.calls[0][1]).toEqual(['test-auth-user','00000000-0000-4000-8000-000000000001']);});
 it('허용 부모의 사건 CSV는 가족 필터·공개 이유·예정분 표시만 포함한다',async()=>{mocks.getUser.mockResolvedValue(verified());mocks.query.mockResolvedValueOnce({rows:[{family_id:'authorized-family'}]}).mockResolvedValueOnce({rows:[{source_business_date:'2026-10-10',child_visible_reason:'확인',pending_minutes_not_balance:30,settlement_status:'NOT_SETTLED'}]});const r=await request('activity-records');expect(r.status).toBe(200);const text=await r.text();expect(text).toContain('pending_minutes_not_balance');expect(text).toContain('NOT_SETTLED');expect(mocks.query.mock.calls[1][0]).toContain('where o.family_id=$1');expect(mocks.query.mock.calls[1][1]).toEqual(['authorized-family']);});
 it('허용 부모의 배정 CSV도 서버가 확인한 가족으로만 제한한다',async()=>{mocks.getUser.mockResolvedValue(verified());mocks.query.mockResolvedValueOnce({rows:[{family_id:'authorized-family'}]}).mockResolvedValueOnce({rows:[]});const r=await request('activity-assignments');expect(r.status).toBe(200);expect(mocks.query.mock.calls[1][0]).toContain('where a.family_id=$1');expect(mocks.query.mock.calls[1][1]).toEqual(['authorized-family']);});
});

describe('데일리·Quest CSV의 접근 및 단위 보존', () => {
 it.each(['routine-records', 'routine-rewards'])('%s는 자녀·보호자·타가족 부모를 거절한다', async dataset => {
  mocks.getUser.mockResolvedValue(verified()); mocks.query.mockResolvedValue({rows:[]});
  const response = await request(dataset); expect(response.status).toBe(403); expect(mocks.query).toHaveBeenCalledTimes(1);
 });
 it('새 수행일·부모 확인 사건 이력을 자기 가족으로만 내보낸다', async () => {
  mocks.getUser.mockResolvedValue(verified()); mocks.query.mockResolvedValueOnce({rows:[{family_id:'authorized-family'}]}).mockResolvedValueOnce({rows:[{source_business_date:'2026-10-15',recorded_stickers:1,accounting_status:'NOT_LEDGER_BALANCE'}]});
  const response = await request('routine-records'); expect(response.status).toBe(200); expect(await response.text()).toContain('NOT_LEDGER_BALANCE');
  expect(mocks.query.mock.calls[1][0]).toContain('where o.family_id=$1'); expect(mocks.query.mock.calls[1][1]).toEqual(['authorized-family']);
 });
 it('보상별 단위·이행·재검토를 별도 행과 감사 이력으로 보존한다', async () => {
  mocks.getUser.mockResolvedValue(verified()); mocks.query.mockResolvedValueOnce({rows:[{family_id:'authorized-family'}]}).mockResolvedValueOnce({rows:[{reward_unit:'WON',amount:10000,requires_review:true,accounting_status:'INDEPENDENT_ENTITLEMENT_NOT_BALANCE'}]});
  const response = await request('routine-rewards'); expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain('requires_review'); expect(text).toContain('INDEPENDENT_ENTITLEMENT_NOT_BALANCE');
  expect(mocks.query.mock.calls[1][0]).toContain('where e.family_id=$1'); expect(mocks.query.mock.calls[1][0]).toContain('routine_entitlement_events'); expect(mocks.query.mock.calls[1][1]).toEqual(['authorized-family']);
  });
});

describe('10월 시행령 CSV 준비', () => {
 it.each(['october-records', 'october-rights'] as const)('%s도 자녀·보호자·타가족 부모를 부모 권한 조회에서 차단한다', async dataset => {
  mocks.getUser.mockResolvedValue(verified());
  mocks.query.mockResolvedValue({ rows: [] });

  const response = await request(dataset);

  expect(response.status).toBe(403);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][0]).toContain("fm.role in ('OWNER_PARENT', 'PARENT')");
  expect(mocks.query.mock.calls[0][1]).toEqual(['test-auth-user', '00000000-0000-4000-8000-000000000001']);
 });

 it('허용 부모에게 occurrence의 현재 스냅샷만 고정 열로 내보낸다', async () => {
  mocks.getUser.mockResolvedValue(verified());
  mocks.query.mockResolvedValueOnce({ rows: [{ family_id: 'authorized-family' }] }).mockResolvedValueOnce({ rows: [{
   code: 'Q-001', name: '숙제', date: '2026-10-15', slot: 'daily', state: 'PASS', revision: 2,
   recognized_count: 1, parent_verified_at: '2026-10-15T09:00:00Z', effect_json: '[]', parent_reason: '확인',
  }] });

  const response = await request('october-records');

  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('"code","name","date","slot","state","revision","recognized_count","parent_verified_at","effect_json","parent_reason"');
  expect(text).toContain('"Q-001"');
  const [sql, params] = mocks.query.mock.calls[1];
  expect(sql).toContain('from public.october_occurrences o');
  expect(sql).toContain('rv.id = o.rule_version_id and rv.family_id = o.family_id');
  expect(sql).toContain('ri.id = rv.rule_identity_id and ri.family_id = rv.family_id');
  expect(sql).toContain('where o.family_id = $1');
  expect(params).toEqual(['authorized-family']);
 });

 it('허용 부모에게 right의 현재 이행 수량만 고정 열로 내보낸다', async () => {
  mocks.getUser.mockResolvedValue(verified());
  mocks.query.mockResolvedValueOnce({ rows: [{ family_id: 'authorized-family' }] }).mockResolvedValueOnce({ rows: [{
   asset: 'MINUTES', quantity: 30, fulfilled: 10, status: 'ISSUED', source_date: '2026-10-15', issued_at: '2026-10-15T10:00:00Z',
  }] });

  const response = await request('october-rights');

  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('"asset","quantity","fulfilled","status","source_date","issued_at"');
  expect(text).toContain('"10"');
  const [sql, params] = mocks.query.mock.calls[1];
  expect(sql).toContain('from public.october_rights r');
  expect(sql).toContain('where r.family_id = $1');
  expect(params).toEqual(['authorized-family']);
 });

 it('10월 export SQL은 잘못된 가족 쿼리 재사용과 원문 payload·감사 event 노출을 하지 않는다', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/routes/exports.ts'), 'utf8');
  const recordsBlock = source.slice(source.indexOf('if (dataset === "october-records")'), source.indexOf('if (dataset === "october-rights")'));
  const rightsBlock = source.slice(source.indexOf('if (dataset === "october-rights")'), source.indexOf('if (dataset === "routine-records")'));

  expect(recordsBlock).toContain('where o.family_id = $1');
  expect(recordsBlock).not.toContain('october_occurrence_events');
  expect(recordsBlock).not.toContain('request_payload');
  expect(recordsBlock).not.toContain('response_payload');
  expect(rightsBlock).toContain('where r.family_id = $1');
  expect(rightsBlock).not.toContain('october_fulfillments');
  expect(rightsBlock).not.toContain('request_payload');
 });

 it('스키마 전에도 고정 열을 유지하고 모든 CSV 셀의 수식 접두사를 무력화한다', () => {
  expect(OCTOBER_RECORD_CSV_COLUMNS).toEqual([
   'code', 'name', 'date', 'slot', 'state', 'revision', 'recognized_count',
   'parent_verified_at', 'effect_json', 'parent_reason',
  ]);
  expect(OCTOBER_RIGHT_CSV_COLUMNS).toEqual([
   'asset', 'quantity', 'fulfilled', 'status', 'source_date', 'issued_at',
  ]);
  const csv = toCsvWithColumns(OCTOBER_RECORD_CSV_COLUMNS, [{
   code: 'T-001', effect_json: '=HYPERLINK("https://bad.example")', parent_reason: '+formula',
  }]);
  expect(csv).toContain('"recognized_count"');
  expect(csv).toContain(`"'=HYPERLINK(""https://bad.example"")"`);
  expect(csv).toContain('"\'+formula"');
  expect(csv).not.toContain('audit_event');
 });
});

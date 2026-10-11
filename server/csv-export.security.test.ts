import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUser:vi.fn(), query:vi.fn() }));
vi.mock("@supabase/supabase-js",()=>({createClient:()=>({auth:{getUser:mocks.getUser}})}));
vi.mock("pg",()=>({Pool:class {query=mocks.query;}}));
vi.mock("./supabaseConnection",()=>({getSupabaseConnectionString:()=>"postgresql://test@localhost/test"}));
import {registerExportRoutes} from "./routes/exports";
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

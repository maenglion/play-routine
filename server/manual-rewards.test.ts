import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  WEEKLY_MONEY_PRESET,
  bonusCouponStatusLabel,
  bonusUnitLabel,
  formatKrw,
  flatWeeklyMoneyConfiguration,
  isoWeekRange,
  isWholeNumberAtLeast,
  moneyRewardStatusLabel,
  normalizeMoneyRewardRow,
  validateWeeklyMoneyInput,
  weeklyScheduledAmount,
} from "../client/src/lib/manual-rewards";

describe("manual reward calendar and preset contract", () => {
  it("derives ISO Monday-Sunday weeks across month/year boundaries", () => {
    expect(isoWeekRange("2026-01-01")).toEqual({ start: "2025-12-29", end: "2026-01-04" });
    expect(isoWeekRange("2026-03-08")).toEqual({ start: "2026-03-02", end: "2026-03-08" });
    expect(isoWeekRange("2024-12-31")).toEqual({ start: "2024-12-30", end: "2025-01-05" });
  });

  it("rejects impossible/malformed calendar dates instead of silently rolling them", () => {
    expect(() => isoWeekRange("2026-02-29")).toThrow("실제 달력 날짜");
    expect(() => isoWeekRange("03/08/2026")).toThrow("YYYY-MM-DD");
  });

  it("keeps the legacy optional preset arithmetic (not the current operating policy)", () => {
    expect(WEEKLY_MONEY_PRESET).toEqual({ baseAmountKrw: 10_000, praiseThreshold: 5, praiseTotalAmountKrw: 15_000 });
    expect(weeklyScheduledAmount({ goodThisWeek: true, praiseCount: 4, ...WEEKLY_MONEY_PRESET })).toBe(10_000);
    expect(weeklyScheduledAmount({ goodThisWeek: true, praiseCount: 5, ...WEEKLY_MONEY_PRESET })).toBe(15_000);
    expect(weeklyScheduledAmount({ goodThisWeek: true, praiseCount: 50, ...WEEKLY_MONEY_PRESET })).toBe(15_000);
  });

  it("current UI uses a parent-entered amount with no praise-based addition", () => {
    const config = flatWeeklyMoneyConfiguration(7000);
    expect(config).toEqual({ praiseCount: 0, baseAmountKrw: 7000, praiseThreshold: 1, praiseTotalAmountKrw: 7000 });
    expect(weeklyScheduledAmount({ goodThisWeek: true, ...config })).toBe(7000);
    expect(weeklyScheduledAmount({ goodThisWeek: false, ...config })).toBeNull();
  });

  it("does not turn unchecked weekly review into zero KRW or an automatic payout", () => {
    expect(weeklyScheduledAmount({ goodThisWeek: false, praiseCount: 5, ...WEEKLY_MONEY_PRESET })).toBeNull();
  });

  it("requires finite non-negative praise counts and positive integer money configuration", () => {
    expect(validateWeeklyMoneyInput({ praiseCount: 0, ...WEEKLY_MONEY_PRESET })).toBeNull();
    expect(validateWeeklyMoneyInput({ praiseCount: -1, ...WEEKLY_MONEY_PRESET })).toContain("0 이상의 정수");
    expect(validateWeeklyMoneyInput({ praiseCount: Number.NaN, ...WEEKLY_MONEY_PRESET })).toContain("0 이상의 정수");
    expect(validateWeeklyMoneyInput({ praiseCount: Infinity, ...WEEKLY_MONEY_PRESET })).toContain("0 이상의 정수");
    expect(validateWeeklyMoneyInput({ praiseCount: 0, baseAmountKrw: 0, praiseThreshold: 5, praiseTotalAmountKrw: 15_000 })).toContain("기본 금액");
    expect(validateWeeklyMoneyInput({ praiseCount: 0, baseAmountKrw: 10_000, praiseThreshold: 1.5, praiseTotalAmountKrw: 15_000 })).toContain("칭찬 기준");
    expect(validateWeeklyMoneyInput({ praiseCount: 5, baseAmountKrw: 15_000, praiseThreshold: 5, praiseTotalAmountKrw: 10_000 })).toContain("작을 수 없습니다");
    expect(isWholeNumberAtLeast("10", 1)).toBe(true);
    expect(isWholeNumberAtLeast("10.5", 1)).toBe(false);
  });

  it("keeps child-facing state language separate from balances and transfer claims", () => {
    expect(moneyRewardStatusLabel("SCHEDULED")).toBe("지급 예정");
    expect(moneyRewardStatusLabel("PAID")).toBe("지급 완료");
    expect(bonusCouponStatusLabel("ISSUED")).toBe("발행됨");
    expect(bonusUnitLabel("TIME_MINUTES")).toContain("시간 쿠폰");
    expect(formatKrw(15_000)).toBe("15,000원");
    expect(formatKrw(null)).toBe("—");
  });

  it("keeps nullable RPC values null instead of coercing them to zero or false", () => {
    const row = {
      reward_id: "reward", child_profile_id: "child", reward_kind: "WEEKLY", period_start: "2026-01-05", period_end: "2026-01-11",
      event_title: null, status: "PENDING", scheduled_amount_krw: null, good_this_week: null, praise_count: null,
      base_amount_snapshot_krw: null, praise_threshold_snapshot: null, praise_total_amount_snapshot_krw: null, paid_on: null, created_at: "2026-01-05T00:00:00Z",
    };
    const rpc = vi.fn().mockReturnValue({ data: [row], error: null });
    const response = rpc("list_parent_manual_rewards", { p_family_id: "family" });
    const normalized = normalizeMoneyRewardRow(response.data[0]);
    expect(rpc).toHaveBeenCalledWith("list_parent_manual_rewards", { p_family_id: "family" });
    expect(normalized).toMatchObject({ scheduled_amount_krw: null, good_this_week: null, praise_count: null, base_amount_snapshot_krw: null });
    expect(normalizeMoneyRewardRow({ ...row, scheduled_amount_krw: "", good_this_week: false, praise_count: false })).toMatchObject({
      scheduled_amount_krw: null, good_this_week: false, praise_count: null,
    });
  });
});

const runLive = process.env.RUN_LIVE_SUPABASE_TESTS === "1";
(runLive ? describe : describe.skip)("수동 보상 실DB 계약", () => {
  it("주간 멱등성·기간 종료·쿠폰 상태·RLS를 롤백으로 검증한다", async () => {
    const { stdout } = await promisify(execFile)("pnpm", ["exec", "tsx", "scripts/verify-manual-rewards-live.ts"], {
      cwd: process.cwd(), env: process.env, timeout: 120_000,
    });
    expect(stdout).toContain("MANUAL_REWARDS_LIVE_OK");
  }, 130_000);
});

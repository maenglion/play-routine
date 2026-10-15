import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  resumedRoutineStep,
  selectExistingReinforcer,
} from "../client/src/lib/reinforcer-reuse";
import { createEmptyRoutinePayload } from "../client/src/lib/routine-v2-form";
import ReinforcerTags from "../client/src/components/play-routine/ReinforcerTags";
import type { RoutineRewardInput } from "../shared/routine-v2";

const reward: RoutineRewardInput = {
  id: "reward",
  reinforcerId: "cash",
  amount: 10000,
  text: "",
};
describe("기존 강화물 재사용", () => {
  it("같은 태그를 다시 선택해도 10000원 입력을 지우지 않는다", () => {
    expect(selectExistingReinforcer(reward, "cash")).toBe(reward);
  });
  it("다른 강화물을 선택할 때만 값과 문구를 초기화하며 보상 ID는 유지한다", () => {
    expect(selectExistingReinforcer(reward, "wish")).toEqual({
      ...reward,
      reinforcerId: "wish",
      amount: null,
      text: "",
    });
    expect(reward.amount).toBe(10000);
  });
  it("소원 태그 재선택도 작성 중인 내용을 유지한다", () => {
    const wish = {
      ...reward,
      reinforcerId: "wish",
      amount: null,
      text: "롯데월드 가기",
    };
    expect(selectExistingReinforcer(wish, "wish")).toBe(wish);
  });
  it("활동 이름을 1단계에 저장한 뒤 이어쓰면 조건·보상 2단계로 간다", () => {
    const payload = { ...createEmptyRoutinePayload(), name: "학교생활" };
    expect(resumedRoutineStep({ step: 1, payload })).toBe(2);
  });
  it("이름이 없는 미완성 초안은 1단계, 2/3단계는 원래 단계에서 이어쓴다", () => {
    const payload = createEmptyRoutinePayload();
    expect(resumedRoutineStep({ step: 1, payload })).toBe(1);
    expect(resumedRoutineStep({ step: 2, payload })).toBe(2);
    expect(resumedRoutineStep({ step: 3, payload })).toBe(3);
  });
  it("태그는 선택한 강화물을 aria-pressed로 표시하고 저장 버튼을 만들지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(ReinforcerTags, {
        rows: [
          { id: "cash", name: "쿠페이머니", unit: "WON", unit_label: "원" },
        ],
        selectedId: "cash",
        label: "기존 보상",
        onSelect: () => undefined,
      })
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("쿠페이머니");
    expect(html).not.toContain("강화물 저장");
  });
  it("카탈로그 요약 태그는 클릭으로 보상을 자동 배정하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(ReinforcerTags, {
        rows: [
          { id: "time", name: "자유 시간", unit: "MIN", unit_label: "분" },
        ],
        label: "가족 목록",
      })
    );
    expect(html).toContain("자유 시간");
    expect(html).not.toContain("<button");
  });
});

describe.runIf(process.env.RUN_LIVE_SUPABASE_TESTS === "1")(
  "미사용 강화물 관리 삭제 실DB",
  () => {
    it("권한·초안/게시 참조·감사 불변·한 건 삭제를 롤백 fixture로 확인한다", async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/verify-reinforcer-removal-live.ts"],
        { cwd: process.cwd(), env: process.env, timeout: 120000 }
      );
      expect(stdout).toContain("REINFORCER_REMOVAL_LIVE_OK 10개");
    }, 150000);
  }
);

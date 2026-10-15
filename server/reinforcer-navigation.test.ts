import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { focusReinforcerRegistration } from "../client/src/lib/reinforcer-navigation";
import RoutineRuleWizard from "../client/src/components/play-routine/RoutineRuleWizard";
import ParentDashboard from "../client/src/components/play-routine/ParentDashboard";

vi.mock("../client/src/lib/supabase", () => ({ supabase: { rpc: vi.fn() } }));

// 효과를 실행하지 않는 SSR 검사이므로 실계정·메일·DB를 건드리지 않는다.
describe("강화물 등록 진입", () => {
  it("기본 Reward 화면에도 강화물 폼이 한 번만 마운트되고 탭 밖에 있다", () => {
    const html = renderToStaticMarkup(
      createElement(RoutineRuleWizard, { familyId: "preview", preview: true })
    );
    expect(html).toContain('id="parent-reinforcers"');
    expect(html).toContain("강화물 등록");
    expect(html).toContain("강화물 저장");
    expect(html).toContain("소원·활동 · 내용");
    expect(html.match(/id="routine-reinforcer-name"/g)).toHaveLength(1);
    expect(html.indexOf('id="parent-reinforcers"')).toBeLessThan(
      html.indexOf('role="tablist"')
    );
    expect(html).not.toContain('value="reinforcers"');
  });

  it("부모 상단의 첫 바로가기가 등록 영역을 가리킨다", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(ParentDashboard, {
        family: {
          id: "preview",
          name: "미리보기 가족",
          timezone: "Asia/Seoul",
        },
        children: [],
        invitations: [],
        resendInvitationId: null,
        resendEmail: "",
        onResendInvitationChange: noop,
        onResendEmailChange: noop,
        onResendInvitation: noop,
        childName: "",
        childEmail: "",
        busy: false,
        onChildNameChange: noop,
        onChildEmailChange: noop,
        onInvite: noop,
        onDownloadCsv: noop,
        onLogout: noop,
      })
    );
    expect(html).toContain('href="#parent-reinforcers"');
    expect(html.indexOf('href="#parent-reinforcers"')).toBeLessThan(
      html.indexOf('href="#parent-rule-registry"')
    );
    expect(html).toMatch(/<details[^>]*id="parent-family-settings"[^>]*>/);
    expect(html).toMatch(/<details[^>]*id="parent-record-exports"[^>]*>/);
    expect(html).not.toMatch(
      /<details[^>]*id="parent-family-settings"[^>]*open/
    );
    expect(html).not.toMatch(
      /<details[^>]*id="parent-record-exports"[^>]*open/
    );
    expect(html).not.toMatch(
      /<details[^>]*id="reinforcer-registration-form"[^>]*open/
    );
  });

  it("바로가기는 새 등록 폼만 펼치고 초안·탭 변경 없이 제목으로 이동한다", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const form = { open: false };
    const root = {
      getElementById: vi.fn((id: string) =>
        id === "parent-reinforcers"
          ? { scrollIntoView }
          : id === "reinforcer-registration-form"
            ? form
            : { focus }
      ),
    };
    expect(focusReinforcerRegistration(root as unknown as Document)).toBe(true);
    expect(form.open).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("등록 영역이 없는 자녀·보호자 화면에서는 아무 동작 없이 종료한다", () => {
    const getElementById = vi.fn(() => null);
    expect(focusReinforcerRegistration({ getElementById })).toBe(false);
    expect(getElementById).toHaveBeenCalledTimes(1);
  });
});

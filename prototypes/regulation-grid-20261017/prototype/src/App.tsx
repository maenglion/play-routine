import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { rules, domainLabel, type Rule, type Domain } from "./rules";
import {
  acknowledge,
  money,
  schoolSummary,
  quoteCSV,
  type Occurrence,
  type SchoolDay,
  type Right,
} from "./logic";

const STORE = "play-routine-ordinance-prototype-v1";
const PERIOD = "demo-family/demo-child/T-007/2026-10-19/2026-10-26/Asia-Seoul";
const schoolDates = [
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
];
const navigation = [
  ["/operations", "운영표"],
  ["/regulations", "규정"],
  ["/rewards", "보상·원장"],
  ["/reinforcers", "강화물"],
  ["/settings", "설정·기록"],
];
const names: Record<string, string> = {
  "/operations": "부모 운영표",
  "/regulations": "규정과 10월 시행령",
  "/rewards": "보상권과 실제 이행",
  "/reinforcers": "반복해서 쓰는 강화물",
  "/settings": "설정과 기록",
};
type Audit = { id: string; at: string; action: string; detail: string };
type Reinforcer = { id: string; name: string; asset: string; unit: string };
type State = {
  occurrences: Occurrence[];
  school: SchoolDay[];
  rights: Right[];
  paid: number;
  audit: Audit[];
  reinforcers: Reinforcer[];
};
const initial = (): State => ({
  occurrences: ["1", "2", "3", "4"].map((id) => ({
    id: "demo-life-" + id,
    code: "L-001",
    date: "2026-10-21",
    occurredAt: "2026-10-21T17:00:00+09:00",
    reported: true,
    verdict: "PENDING" as const,
    reason: "",
    minutes: 0,
    revision: 0,
    requestKey: "demo-request-" + id,
  })),
  school: schoolDates.map((date, i) => ({
    date,
    base: i === 3 ? null : 1,
    praise: 0,
    feedback: i !== 3,
  })),
  rights: [],
  paid: 0,
  audit: [],
  reinforcers: [
    { id: "media", name: "미디어 쿠폰", asset: "MEDIA_MIN", unit: "분" },
    { id: "cash", name: "현금", asset: "CASH_KRW", unit: "원" },
    { id: "coupay", name: "쿠페이머니", asset: "COUPAY_KRW", unit: "원" },
    { id: "wish", name: "소원·체험", asset: "WISH", unit: "내용" },
  ],
});
function load(): State {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    if (
      v &&
      Array.isArray(v.occurrences) &&
      Array.isArray(v.school) &&
      Array.isArray(v.rights) &&
      Array.isArray(v.audit) &&
      Array.isArray(v.reinforcers) &&
      typeof v.paid === "number"
    )
      return v;
  } catch {}
  return initial();
}
const label = {
  PENDING: "부모 미확인",
  APPROVED: "인정",
  NO_EFFECT: "미인정 · 차감 아님",
  LIMIT_EXCEEDED: "한도 초과 · 기록 보존",
  REVIEW_REQUIRED: "시행 조건 검토 필요",
};
function Badge({
  children,
  kind = "neutral",
}: {
  children: React.ReactNode;
  kind?: string;
}) {
  return <span className={"badge " + kind}>{children}</span>;
}

export default function App() {
  const [path, go] = useLocation();
  const search = useSearch();
  const query = new URLSearchParams(search);
  const view = query.get("view") === "week" ? "week" : "day";
  const businessDate = /^2026-10-\d{2}$/.test(query.get("date") || "")
    ? query.get("date")!
    : "2026-10-21";
  const [state, setState] = useState<State>(load);
  const [notice, setNotice] = useState("");
  const [domain, setDomain] = useState<Domain | "ALL">("ALL");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [decision, setDecision] = useState<Occurrence | null>(null);
  const [reason, setReason] = useState("");
  const [reinforcerName, setReinforcerName] = useState("");
  const [asset, setAsset] = useState("MEDIA_MIN");
  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(state));
  }, [state]);
  useEffect(() => {
    if (path === "/") go("/operations");
  }, [path, go]);
  useEffect(() => {
    if (!decision && !selectedRule) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(".drawer textarea,.drawer button")
          ?.focus(),
      0,
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDecision(null);
        setSelectedRule(null);
        return;
      }
      if (e.key !== "Tab") return;
      const els = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".drawer button,.drawer textarea,.drawer input,.drawer select",
        ),
      ).filter((x) => !x.hasAttribute("disabled"));
      if (!els.length) return;
      const first = els[0],
        last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [decision?.id, selectedRule]);
  const summary = schoolSummary(state.school, state.rights, state.paid, PERIOD);
  const current = state.occurrences.filter((e) => e.date === businessDate);
  const filtered = current.filter(
    (e) =>
      (domain === "ALL" ||
        rules.find((r) => r.code === e.code)?.domain === domain) &&
      (!pendingOnly || e.verdict === "PENDING"),
  );
  const chosen = rules.find((r) => r.code === selectedRule);
  const log = (s: State, action: string, detail: string): State => ({
    ...s,
    audit: [
      { id: crypto.randomUUID(), at: new Date().toISOString(), action, detail },
      ...s.audit,
    ],
  });
  function addOccurrence(r: Rule) {
    if (r.code === "T-007") {
      go("/operations?view=week");
      return;
    }
    const event: Occurrence = {
      id: crypto.randomUUID(),
      code: r.code,
      date: businessDate,
      occurredAt: businessDate + "T17:00:00+09:00",
      reported: true,
      verdict: "PENDING",
      reason: "",
      minutes: 0,
      revision: 0,
      requestKey: crypto.randomUUID(),
    };
    setState((s) =>
      log(
        { ...s, occurrences: [...s.occurrences, event] },
        "발생 기록",
        "모의 원사건 " + r.code + " / " + businessDate,
      ),
    );
    setNotice(
      r.negative
        ? "위반 후보만 기록했습니다. 미확인에서는 차감하지 않습니다."
        : "모의 수행 회차를 기록했습니다. 부모 인정은 별도입니다.",
    );
  }
  function bulkApprove() {
    let next = state.occurrences;
    let count = 0;
    for (const e of filtered) {
      const r = rules.find((x) => x.code === e.code)!;
      if (
        e.verdict === "PENDING" &&
        !r.negative &&
        !r.pending &&
        r.cap !== null &&
        r.minutes !== null
      ) {
        next = acknowledge(
          next,
          e.id,
          r.cap,
          r.minutes,
          true,
          "부모 정상 수행 일괄 인정",
        );
        count++;
      }
    }
    setState((s) =>
      log(
        { ...s, occurrences: next },
        "명시적 일괄 확인",
        count + "개 회차 검토 · 초과 원사건 보존",
      ),
    );
    setNotice(
      "명시한 정상 회차만 확인했습니다. 초과는 무보상, 미정·패널티는 미확인 상태로 남습니다.",
    );
  }
  function confirm(allow: boolean) {
    if (!decision) return;
    const r = rules.find((r) => r.code === decision.code)!;
    if (allow && r.negative && !reason.trim()) {
      setNotice("차감 후보 인정에는 실제 위반 확인 사유가 필요합니다.");
      return;
    }
    // 독립 UI 모형: 미확정 규칙은 실제 지급 대신 검토 상태에 남긴다.
    const safeCap = r.negative || r.pending ? null : r.cap;
    const next = acknowledge(
      state.occurrences,
      decision.id,
      safeCap,
      r.minutes,
      allow,
      reason.trim() || "부모 정상 수행 인정",
    );
    const row = next.find((e) => e.id === decision.id)!;
    setState((s) =>
      log(
        { ...s, occurrences: next },
        "부모 확인",
        r.code + " · " + label[row.verdict],
      ),
    );
    setDecision(null);
    setReason("");
    setNotice(
      row.verdict === "APPROVED"
        ? r.negative
          ? "승인 차감 후보를 기록했습니다. 실제 잔액은 변경하지 않습니다."
          : "샘플 인정 한도를 적용했습니다. 실제 원장은 변경하지 않습니다."
        : label[row.verdict],
    );
  }
  function issue() {
    if (!summary.canIssue) {
      setNotice(
        summary.incomplete
          ? "미확인·피드백 미수신·문제/칭찬 충돌이 있어 최종 마감을 보류합니다."
          : "이미 발행·이행된 보상보다 목표가 작아 검토가 필요합니다.",
      );
      return;
    }
    if (summary.additional === 0) {
      setNotice("추가 발행 0원 — 같은 기간의 권리를 다시 만들지 않습니다.");
      return;
    }
    const right = {
      id: crypto.randomUUID(),
      period: PERIOD,
      amount: summary.additional,
      issuedAt: new Date().toISOString(),
    };
    setState((s) =>
      log(
        { ...s, rights: [...s.rights, right] },
        "샘플 보상권 발행",
        money(right.amount) + "원 · 목표총액 " + money(summary.target) + "원",
      ),
    );
    setNotice(
      "쿠페이머니 보상권 " +
        money(right.amount) +
        "원을 모의 발행했습니다. 실제 충전은 아닙니다.",
    );
  }
  function fulfill() {
    if (summary.review) {
      setNotice("정정 검토 중인 권리는 이행할 수 없습니다.");
      return;
    }
    if (summary.outstanding === 0) {
      setNotice("미이행 보상권이 없습니다.");
      return;
    }
    setState((s) =>
      log(
        { ...s, paid: s.paid + summary.outstanding },
        "샘플 이행 기록",
        money(summary.outstanding) + "원",
      ),
    );
    setNotice("모의 지급 확인만 기록했습니다. 실제 송금·충전은 하지 않습니다.");
  }
  function download() {
    const header = [
      "사건ID",
      "규칙번호",
      "업무일",
      "부모결과",
      "예정분",
      "사유",
    ];
    const rows = state.occurrences.map((e) => [
      e.id,
      e.code,
      e.date,
      label[e.verdict],
      e.minutes,
      e.reason,
    ]);
    const csv =
      "\uFEFF" +
      [header, ...rows].map((r) => r.map(quoteCSV).join(",")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "play-routine-demo-records.csv";
    a.click();
    URL.revokeObjectURL(url);
    setNotice("브라우저의 모의 기록만 CSV로 내려받았습니다.");
  }
  function reset() {
    if (
      window.confirm(
        "이 브라우저의 모의 데이터만 초기화할까요? 실제 서비스 데이터에는 영향을 주지 않습니다.",
      )
    ) {
      setState(initial());
      setNotice("모의 데이터만 초기화했습니다.");
    }
  }
  const changeDay = (v: string) => {
    if (v) go("/operations?view=day&date=" + encodeURIComponent(v));
  };
  const readyLifestyle = rules.filter(
    (r) => r.domain === "LIFESTYLE" && !r.negative,
  );
  return (
    <div className="app-shell">
      <a className="skip" href="#main-content">
        본문으로 이동
      </a>
      <header className="topbar">
        <Link href="/operations" className="brand">
          <span className="brand-mark">PR</span>
          <span>
            PLAY ROUTINE<small>부모 작업공간</small>
          </span>
        </Link>
        <nav aria-label="상단 업무 메뉴">
          {navigation.map(([url, text]) => (
            <Link
              key={url}
              href={url}
              className={path === url ? "active" : ""}
              aria-current={path === url ? "page" : undefined}
            >
              {text}
            </Link>
          ))}
        </nav>
        <span className="identity">샘플 가족 · 샘플 자녀</span>
      </header>
      <div className="demo-banner">
        <span>독립 프로토타입</span> 실제 계정·DB·송금과 연결되지 않습니다.
        변경은 이 브라우저에만 저장됩니다.
      </div>
      <main id="main-content" className="workspace">
        <div className="breadcrumb">
          부모 관리 <span>/</span> {names[path] || "페이지 찾기"}
        </div>
        <div className="heading">
          <div>
            <p className="eyebrow">OCTOBER 2026 / DRAFT IMPLEMENTATION</p>
            <h1>{names[path] || "페이지를 찾을 수 없습니다"}</h1>
          </div>
          <span className="context-note">
            기본법 v0.6 · 10월 시행령 v0.5
            <br />
            계산 예시이며 운영 승인본이 아닙니다.
          </span>
        </div>
        {notice && (
          <div className="notice" role="status" aria-live="polite">
            {notice}
            <button
              className="small"
              aria-label="안내 닫기"
              onClick={() => setNotice("")}
            >
              닫기
            </button>
          </div>
        )}
        {path === "/operations" && (
          <>
            <div className="toolbar">
              <div className="segmented">
                <button
                  className={view === "day" ? "selected" : ""}
                  onClick={() =>
                    go("/operations?view=day&date=" + businessDate)
                  }
                >
                  오늘·날짜별
                </button>
                <button
                  className={view === "week" ? "selected" : ""}
                  onClick={() => go("/operations?view=week")}
                >
                  학교 이번 주
                </button>
              </div>
              {view === "day" && (
                <>
                  <label>
                    업무일{" "}
                    <input
                      aria-label="업무일"
                      type="date"
                      min="2026-10-01"
                      max="2026-10-31"
                      value={businessDate}
                      onChange={(e) => changeDay(e.target.value)}
                    />
                  </label>
                  <label>
                    종류{" "}
                    <select
                      aria-label="운영표 종류"
                      value={domain}
                      onChange={(e) =>
                        setDomain(e.target.value as Domain | "ALL")
                      }
                    >
                      <option value="ALL">전체</option>
                      <option value="TASK">Task</option>
                      <option value="QUEST">Quest</option>
                      <option value="LIFESTYLE">Lifestyle</option>
                    </select>
                  </label>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={pendingOnly}
                      onChange={(e) => setPendingOnly(e.target.checked)}
                    />{" "}
                    미확인만
                  </label>
                </>
              )}
            </div>
            {view === "day" ? (
              <>
                <div className="stats-line">
                  <span>
                    오늘 원사건 <b>{current.length}</b>건
                  </span>
                  <span>
                    부모 미확인{" "}
                    <b>
                      {current.filter((e) => e.verdict === "PENDING").length}
                    </b>
                    건
                  </span>
                  <span>
                    인정 예정{" "}
                    <b>
                      {current.reduce((n, e) => n + Math.max(0, e.minutes), 0)}
                    </b>
                    분
                  </span>
                  <span>
                    원장 <b>미연결</b>
                  </span>
                  <button className="small" onClick={bulkApprove}>
                    현재 표 정상 회차 일괄 인정
                  </button>
                </div>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  aria-label="날짜별 부모 운영표"
                >
                  <table>
                    <caption className="sr-only">
                      {businessDate} 수행·부모 확인 원사건
                    </caption>
                    <thead>
                      <tr>
                        {[
                          "번호",
                          "활동 / 실제 회차",
                          "원사건",
                          "부모 결과",
                          "예정 효과",
                          "확인",
                        ].map((h) => (
                          <th key={h} scope="col">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((e) => {
                        const r = rules.find((r) => r.code === e.code)!;
                        const occurrence =
                          current
                            .filter((x) => x.code === e.code)
                            .findIndex((x) => x.id === e.id) + 1;
                        return (
                          <tr key={e.id}>
                            <th scope="row" className="code">
                              {r.code}
                            </th>
                            <td>
                              <strong>{r.name}</strong>
                              <small>
                                {occurrence}회차 ·{" "}
                                {r.cap === null
                                  ? "인정한도 미정"
                                  : r.period === "사건"
                                    ? "같은 사건 1회"
                                    : `일 인정한도 ${r.cap}회`}
                              </small>
                            </td>
                            <td>
                              <Badge>발생 기록</Badge>
                              <small>입력일과 업무일 별도</small>
                            </td>
                            <td>
                              <Badge
                                kind={
                                  e.verdict === "APPROVED"
                                    ? "good"
                                    : e.verdict === "PENDING"
                                      ? "pending"
                                      : "neutral"
                                }
                              >
                                {label[e.verdict]}
                              </Badge>
                              <small>{e.reason}</small>
                            </td>
                            <td>
                              {e.verdict === "PENDING"
                                ? "미확정"
                                : e.verdict === "APPROVED"
                                  ? (e.minutes > 0 ? "+" : "") +
                                    e.minutes +
                                    "분"
                                  : "무효과 또는 보류"}
                            </td>
                            <td>
                              <button
                                className="small"
                                disabled={e.verdict !== "PENDING"}
                                onClick={() => {
                                  setDecision(e);
                                  setReason("");
                                }}
                              >
                                부모 확인
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {!filtered.length && (
                        <tr>
                          <td colSpan={6} className="empty">
                            <strong>
                              이 날짜의 {pendingOnly ? "미확인 " : ""}회차가
                              없습니다.
                            </strong>
                            <span>
                              아래에서 샘플 발생을 기록한 뒤 부모 인정과 횟수
                              한도를 확인하세요.
                            </span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <section className="section compact">
                  <div className="section-title">
                    <h2>샘플 발생 추가</h2>
                    <span>
                      같은 활동을 네 번 기록해도 보상 인정은 일 한도로
                      제한됩니다.
                    </span>
                  </div>
                  <div className="activity-tags">
                    {readyLifestyle.map((r) => (
                      <button key={r.code} onClick={() => addOccurrence(r)}>
                        <span>{r.code}</span>
                        {r.name}
                        <b>
                          +{r.minutes}분 · {r.cap}회/일
                        </b>
                      </button>
                    ))}
                  </div>
                  <details>
                    <summary>Task·Quest·패널티 후보도 기록하기</summary>
                    <div className="activity-tags">
                      {rules
                        .filter((r) => !readyLifestyle.includes(r))
                        .map((r) => (
                          <button key={r.code} onClick={() => addOccurrence(r)}>
                            <span>{r.code}</span>
                            {r.name}
                            <b>{r.reward}</b>
                          </button>
                        ))}
                    </div>
                    <p className="muted">
                      패널티는 직접 확인·사유가 있어야 후보가 인정됩니다. 잔액
                      하한·미정 정책을 건너뛰어 실제 원장 차감을 실행하지
                      않습니다.
                    </p>
                  </details>
                </section>
              </>
            ) : (
              <>
                <p className="scope-note">
                  샘플 주간: 2026-10-19~25, 월요일 시작.{" "}
                  <strong>
                    주간 경계와 일반 지급 시점은 아직 사용자 확정 전
                  </strong>
                  입니다. 문제+칭찬 동시 인정도 확정 전이므로 보류합니다.
                </p>
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">
                      학교 스티커 주간 부모 확인
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">날짜</th>
                        <th scope="col">교사 피드백</th>
                        <th scope="col">부모 기본 인정</th>
                        <th scope="col">칭찬 근거</th>
                        <th scope="col">학교 스티커</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.school.map((d, i) => (
                        <tr key={d.date}>
                          <th scope="row">
                            {d.date}{" "}
                            <small>{["월", "화", "수", "목", "금"][i]}</small>
                          </th>
                          <td>
                            <label className="inline">
                              <input
                                aria-label={d.date + " 교사 피드백"}
                                type="checkbox"
                                checked={d.feedback}
                                onChange={(e) =>
                                  setState((s) =>
                                    log(
                                      {
                                        ...s,
                                        school: s.school.map((x) =>
                                          x.date === d.date
                                            ? {
                                                ...x,
                                                feedback: e.target.checked,
                                              }
                                            : x,
                                        ),
                                      },
                                      "학교 피드백",
                                      d.date,
                                    ),
                                  )
                                }
                              />{" "}
                              확인함
                            </label>
                          </td>
                          <td>
                            <select
                              aria-label={d.date + " 학교 기본 인정"}
                              value={
                                d.base === null ? "pending" : String(d.base)
                              }
                              onChange={(e) =>
                                setState((s) =>
                                  log(
                                    {
                                      ...s,
                                      school: s.school.map((x) =>
                                        x.date === d.date
                                          ? {
                                              ...x,
                                              base:
                                                e.target.value === "pending"
                                                  ? null
                                                  : (Number(e.target.value) as
                                                      | 0
                                                      | 1),
                                            }
                                          : x,
                                      ),
                                    },
                                    "학교 기본 인정",
                                    d.date,
                                  ),
                                )
                              }
                            >
                              <option value="pending">미확인</option>
                              <option value="1">문제없음 · 1개</option>
                              <option value="0">문제있음 · 0개</option>
                            </select>
                          </td>
                          <td>
                            <label className="inline">
                              <input
                                aria-label={d.date + " 학교 칭찬"}
                                type="checkbox"
                                checked={d.praise === 1}
                                onChange={(e) =>
                                  setState((s) =>
                                    log(
                                      {
                                        ...s,
                                        school: s.school.map((x) =>
                                          x.date === d.date
                                            ? {
                                                ...x,
                                                praise: e.target.checked
                                                  ? 1
                                                  : 0,
                                              }
                                            : x,
                                        ),
                                      },
                                      "교사 칭찬 별도 인정",
                                      d.date,
                                    ),
                                  )
                                }
                              />{" "}
                              칭찬 +1
                            </label>
                          </td>
                          <td>
                            {d.base === null || !d.feedback ? (
                              "확인 대기"
                            ) : d.base === 0 && d.praise === 1 ? (
                              "규정 해석 대기"
                            ) : (
                              <b>{d.base + d.praise}개</b>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <section className="school-result">
                  <div>
                    <p className="eyebrow">
                      학교 T-007 · 다른 스티커와 합산하지 않음
                    </p>
                    <h2>
                      확인된 스티커 {summary.total}개{" "}
                      <Badge kind={summary.incomplete ? "pending" : "good"}>
                        {summary.incomplete
                          ? `보류 ${summary.incomplete}일`
                          : "전체 확인"}
                      </Badge>
                    </h2>
                    <p>0~4개 없음 · 5~7개 총 10,000원 · 8개 이상 총 15,000원</p>
                    <p className="muted">
                      5개에서 10,000원 발행 후 8개가 되면 추가 5,000원입니다.
                      중간 지급 사례는 계산 비교용이며 실제 지급 허용을 뜻하지
                      않습니다.
                    </p>
                  </div>
                  <div className="calc-grid">
                    <span>
                      최종 목표총액
                      <b>
                        {summary.incomplete
                          ? "확정 보류"
                          : money(summary.target) + "원"}
                      </b>
                    </span>
                    <span>
                      유효 발행권리<b>{money(summary.issued)}원</b>
                    </span>
                    <span>
                      추가 발행
                      <b>
                        {summary.incomplete
                          ? "보류"
                          : money(summary.additional) + "원"}
                      </b>
                    </span>
                    <span>
                      미이행 권리<b>{money(summary.outstanding)}원</b>
                    </span>
                  </div>
                  <button className="primary" onClick={issue}>
                    샘플 계산·권리 발행
                  </button>
                  {summary.review && (
                    <div className="review">
                      정정으로 목표가 기존 발행·이행보다 작습니다. 자동 회수하지
                      않고 검토합니다.
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
        {path === "/regulations" && (
          <>
            <div className="law-chain">
              <span>PR-BASIC 기본법</span>
              <b>→</b>
              <span>PR-TASK / PR-QUEST / PR-LIFESTYLE</span>
              <b>→</b>
              <span>시행규칙 T·Q·L</span>
              <b>→</b>
              <span>10월 버전 채택</span>
            </div>
            <div className="toolbar">
              <label>
                하위규정{" "}
                <select
                  aria-label="하위규정 필터"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value as Domain | "ALL")}
                >
                  <option value="ALL">전체 26개</option>
                  <option value="TASK">Task 7개</option>
                  <option value="QUEST">Quest 3개</option>
                  <option value="LIFESTYLE">Lifestyle 16개</option>
                </select>
              </label>
              <span className="muted">
                영구 번호와 버전은 별개 · 이번 달 Special 없음
              </span>
            </div>
            <div className="table-scroll tall">
              <table>
                <caption className="sr-only">
                  10월 시행령 규칙·관계·확정 상태
                </caption>
                <thead>
                  <tr>
                    {[
                      "번호",
                      "규칙",
                      "주기",
                      "인정·평가 기준",
                      "보상 / 차감 후보",
                      "상태·원문",
                    ].map((h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rules
                    .filter((r) => domain === "ALL" || r.domain === domain)
                    .map((r) => (
                      <tr key={r.code}>
                        <th scope="row" className="code">
                          {r.code}
                        </th>
                        <td>
                          <strong>{r.name}</strong>
                          <small>{domainLabel[r.domain]}</small>
                        </td>
                        <td>{r.period}</td>
                        <td>{r.criterion}</td>
                        <td>{r.reward}</td>
                        <td>
                          <Badge kind={r.pending ? "pending" : "good"}>
                            {r.pending ? "세부 명세 대기" : "명시 값 반영"}
                          </Badge>
                          <button
                            className="text-button"
                            onClick={() => setSelectedRule(r.code)}
                          >
                            규칙 보기
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              새 버전과 월별 계획은 승인된 정확한 버전을 참조합니다. 이
              프로토타입은 규정을 실제 게시하거나 기존 법령을 초기화하지
              않습니다.
            </p>
          </>
        )}
        {path === "/rewards" && (
          <>
            <section className="school-result">
              <div>
                <p className="eyebrow">COUPAY_KRW · 원 / 학교의 샘플 주간</p>
                <h2>권리와 이행을 두 번 더하지 않습니다</h2>
                <p>목표총액 − 유효 순발행액 = 추가 권리</p>
                <p>유효 권리액 − 실제 이행액 = 아직 줄 금액</p>
              </div>
              <div className="calc-grid">
                <span>
                  발행 보상권<b>{money(summary.issued)}원</b>
                </span>
                <span>
                  모의 이행<b>{money(summary.paid)}원</b>
                </span>
                <span>
                  미이행<b>{money(summary.outstanding)}원</b>
                </span>
                <span>
                  원장 잔액<b>미연결</b>
                </span>
              </div>
              <button className="primary" onClick={fulfill}>
                샘플 지급 확인
              </button>
            </section>
            <div className="table-scroll">
              <table>
                <caption className="sr-only">발행된 모의 학교 보상권</caption>
                <thead>
                  <tr>
                    <th scope="col">보상권</th>
                    <th scope="col">귀속 기간</th>
                    <th scope="col">자산·금액</th>
                    <th scope="col">발행 기록</th>
                  </tr>
                </thead>
                <tbody>
                  {state.rights.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.id.slice(0, 8)}</th>
                      <td>2026-10-19~25 / 학교 T-007</td>
                      <td>쿠페이머니 {money(r.amount)}원</td>
                      <td>{new Date(r.issuedAt).toLocaleString("ko-KR")}</td>
                    </tr>
                  ))}
                  {!state.rights.length && (
                    <tr>
                      <td colSpan={4} className="empty">
                        아직 모의 보상권이 없습니다. 운영표의 ‘학교 이번 주’에서
                        확인하세요.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="scope-note">
              생활습관의 예정분, 보상권 발행, 실제 송금·충전, 자정 원장은 다른
              층입니다. 실제 계좌·쿠페이·원장에는 연결되지 않습니다.
            </p>
          </>
        )}
        {path === "/reinforcers" && (
          <>
            <p className="scope-note">
              한 번 등록한 강화물을 여러 규칙에서 같은 ID·정의 버전으로
              재사용합니다. 시간·현금·쿠페이머니·소원은 자동 합산하지 않습니다.
            </p>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reinforcerName.trim()) return;
                const units: Record<string, string> = {
                  MEDIA_MIN: "분",
                  CASH_KRW: "원",
                  COUPAY_KRW: "원",
                  WISH: "내용",
                };
                const item = {
                  id: crypto.randomUUID(),
                  name: reinforcerName.trim(),
                  asset,
                  unit: units[asset],
                };
                setState((s) =>
                  log(
                    { ...s, reinforcers: [...s.reinforcers, item] },
                    "모의 강화물 등록",
                    item.name,
                  ),
                );
                setReinforcerName("");
                setNotice("모의 카탈로그에만 등록했습니다.");
              }}
            >
              <label>
                강화물 이름
                <input
                  aria-label="강화물 이름"
                  value={reinforcerName}
                  onChange={(e) => setReinforcerName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="새 제공 항목"
                />
              </label>
              <label>
                독립 자산
                <select
                  aria-label="강화물 자산"
                  value={asset}
                  onChange={(e) => setAsset(e.target.value)}
                >
                  <option value="MEDIA_MIN">시간 · 분</option>
                  <option value="CASH_KRW">현금 · 원</option>
                  <option value="COUPAY_KRW">쿠페이머니 · 원</option>
                  <option value="WISH">소원·체험 · 내용</option>
                </select>
              </label>
              <button className="primary">샘플 카탈로그 등록</button>
            </form>
            <div className="table-scroll">
              <table>
                <caption className="sr-only">
                  반복 사용하는 모의 강화물 정의
                </caption>
                <thead>
                  <tr>
                    <th scope="col">강화물</th>
                    <th scope="col">자산 ID</th>
                    <th scope="col">단위</th>
                    <th scope="col">재사용</th>
                  </tr>
                </thead>
                <tbody>
                  {state.reinforcers.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.name}</th>
                      <td className="code">{r.asset}</td>
                      <td>{r.unit}</td>
                      <td>조건별 수량 연결 · 두 번째 보상 선택</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {path === "/settings" && (
          <>
            <div className="settings-row">
              <span>가족·자녀</span>
              <strong>샘플 가족 / 샘플 자녀</strong>
              <Badge>로그인·실계정 미연결</Badge>
            </div>
            <div className="settings-row">
              <span>업무 시간대</span>
              <strong>Asia/Seoul</strong>
              <small>업무일과 입력일 별도</small>
            </div>
            <details className="section">
              <summary>계정 연결·조회 전용 보호자</summary>
              <p>
                이 화면은 실제 가입·초대를 보내지 않습니다. 통합할 때 부모는
                해당 가족만 수정하고 자녀는 자기 신고, 보호자는 상태 조회만
                허용합니다.
              </p>
            </details>
            <details className="section">
              <summary>복약·양육일기 접근 범위</summary>
              <p>
                아침·저녁 기록은 별도 민감 관계입니다. 공란에서 위반을 만들지
                않습니다. L-013은 부모 직접 확인한 별도 생활 사건이며 이
                프로토타입에는 실제 복약 기록이 없습니다.
              </p>
            </details>
            <div className="toolbar">
              <button onClick={download}>샘플 기록 CSV</button>
              <button className="danger-button" onClick={reset}>
                모의 데이터만 초기화
              </button>
            </div>
            <div className="table-scroll tall">
              <table>
                <caption className="sr-only">모의 사용자 동작 기록</caption>
                <thead>
                  <tr>
                    <th scope="col">시각</th>
                    <th scope="col">동작</th>
                    <th scope="col">원천·결과</th>
                  </tr>
                </thead>
                <tbody>
                  {state.audit.map((a) => (
                    <tr key={a.id}>
                      <th scope="row">
                        {new Date(a.at).toLocaleString("ko-KR")}
                      </th>
                      <td>{a.action}</td>
                      <td>{a.detail}</td>
                    </tr>
                  ))}
                  {!state.audit.length && (
                    <tr>
                      <td colSpan={3} className="empty">
                        샘플 동작 기록이 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!names[path] && <Link href="/operations">운영표로 돌아가기</Link>}
        <footer>
          Play Routine · 구조와 운영을 확인하는 프로토타입 / 실제 운영 전
          권한·동시성·정산 통합 검증 필요
        </footer>
      </main>
      {decision && (
        <div className="modal-backdrop">
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-title"
          >
            <button className="close" onClick={() => setDecision(null)}>
              닫기
            </button>
            <p className="eyebrow">
              부모 확인 · 원사건 {decision.id.slice(0, 8)}
            </p>
            <h2 id="decision-title">
              {rules.find((r) => r.code === decision.code)?.name}
            </h2>
            <p>
              {decision.date}의 실제 수행/위반을 확인합니다. 기존 스티커·쿠폰은
              회수하지 않습니다.
            </p>
            <label>
              사유 / 관찰
              <textarea
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="통상 PASS는 생략 가능 · 차감 후보는 실제 위반 사유 필수"
              />
            </label>
            <div className="drawer-actions">
              <button onClick={() => confirm(false)}>미인정 · 차감 없음</button>
              <button className="primary" onClick={() => confirm(true)}>
                {rules.find((r) => r.code === decision.code)?.negative
                  ? "직접 확인 · 후보 승인"
                  : "이번 수행 인정"}
              </button>
            </div>
          </section>
        </div>
      )}
      {chosen && (
        <div className="modal-backdrop">
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rule-title"
          >
            <button className="close" onClick={() => setSelectedRule(null)}>
              닫기
            </button>
            <p className="eyebrow">
              {chosen.code} · 제안 영구번호 / 10월 채택 초안
            </p>
            <h2 id="rule-title">{chosen.name}</h2>
            <dl>
              <dt>하위규정</dt>
              <dd>PR-{chosen.domain}</dd>
              <dt>인정·평가</dt>
              <dd>{chosen.criterion}</dd>
              <dt>보상 또는 승인 차감 후보</dt>
              <dd>{chosen.reward}</dd>
              <dt>남은 경계</dt>
              <dd>
                {chosen.pending ||
                  "명시 값은 반영됨. 실제 운영 전 전환·기간·전체 승인 필요."}
              </dd>
            </dl>
            <p className="scope-note">
              원문·개정 이력과 확정 버전은 삭제하지 않습니다. 다음 달에는 재등록
              대신 같은 버전을 채택합니다.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

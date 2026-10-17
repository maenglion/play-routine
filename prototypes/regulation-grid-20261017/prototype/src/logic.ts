export type Verdict =
  | "PENDING"
  | "APPROVED"
  | "NO_EFFECT"
  | "LIMIT_EXCEEDED"
  | "REVIEW_REQUIRED";
export type Occurrence = {
  id: string;
  code: string;
  date: string;
  occurredAt: string;
  reported: boolean;
  verdict: Verdict;
  reason: string;
  minutes: number;
  revision: number;
  requestKey: string;
};
export type SchoolDay = {
  date: string;
  base: 0 | 1 | null;
  praise: 0 | 1;
  feedback: boolean;
};
export type Right = {
  id: string;
  period: string;
  amount: number;
  issuedAt: string;
};
export const schoolTarget = (count: number): number =>
  count >= 8 ? 15000 : count >= 5 ? 10000 : 0;
export function schoolSummary(
  days: SchoolDay[],
  rights: Right[],
  paid: number,
  period: string,
) {
  const incomplete = days.filter(
    (d) => d.base === null || !d.feedback || (d.base === 0 && d.praise === 1),
  ).length;
  const total = days.reduce(
    (n, d) =>
      n +
      (d.base === null || !d.feedback || (d.base === 0 && d.praise === 1)
        ? 0
        : d.base + d.praise),
    0,
  );
  const issued = rights
    .filter((r) => r.period === period)
    .reduce((n, r) => n + r.amount, 0);
  const target = schoolTarget(total);
  return {
    total,
    incomplete,
    issued,
    paid,
    target,
    additional: Math.max(0, target - issued),
    outstanding: Math.max(0, issued - paid),
    review: incomplete === 0 && (issued > target || paid > target),
    canIssue: incomplete === 0 && issued <= target && paid <= target,
  };
}
export function acknowledge(
  list: Occurrence[],
  id: string,
  cap: number | null,
  unit: number | null,
  allow: boolean,
  reason: string,
): Occurrence[] {
  const selected = list.find((e) => e.id === id);
  if (!selected || selected.verdict !== "PENDING") return list;
  const used = list.filter(
    (e) =>
      e.id !== id &&
      e.date === selected.date &&
      e.code === selected.code &&
      e.verdict === "APPROVED",
  ).length;
  const verdict: Verdict = !allow
    ? "NO_EFFECT"
    : cap === null || unit === null
      ? "REVIEW_REQUIRED"
      : used >= cap
        ? "LIMIT_EXCEEDED"
        : "APPROVED";
  return list.map((e) =>
    e.id === id
      ? {
          ...e,
          verdict,
          reason,
          minutes: verdict === "APPROVED" ? unit! : 0,
          revision: e.revision + 1,
        }
      : e,
  );
}
export const money = (n: number) => new Intl.NumberFormat("ko-KR").format(n);
export function quoteCSV(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

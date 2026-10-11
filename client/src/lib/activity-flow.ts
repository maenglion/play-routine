export type ActivityVerificationStatus = "MISSING" | "HELD" | "CONFIRMED";

/**
 * Exact row contract returned by `list_activity_day`.
 * Numeric values are intentionally numbers here: callers must not infer an effect
 * from a missing, non-finite, or string-shaped value.
 */
export type ActivityDayRow = {
  occurrence_id: string;
  assignment_id: string;
  policy_rule_id: string;
  business_date: string;
  activity_name: string;
  description: string | null;
  category_code: string;
  metric_label: string;
  reward_minutes: number;
  penalty_minutes: number;
  child_reported: boolean;
  verification_status: ActivityVerificationStatus;
  parent_score: number | null;
  outcome_code: string | null;
  confirmed_minutes: number | null;
  revision: number;
  /** Parent-approved explanation shown with the verification; never a private memo. */
  parent_reason?: string | null;
  parent_verified_at?: string | null;
};

export type ActivityDaySummary = {
  total: number;
  reported: number;
  confirmed: number;
  held: number;
  missing: number;
  positiveMinutes: number;
  signedMinutes: number;
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * Returns the calendar date in the family's IANA timezone, rather than the
 * browser/UTC date. `Intl` owns timezone/DST conversion; no offset arithmetic
 * is performed here.
 */
export function familyBusinessDate(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  ) as Record<string, string>;

  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Advances an ISO calendar date by one day using UTC calendar semantics. This
 * avoids a 24-hour local-time calculation, which would be wrong across DST.
 */
export function nextBusinessDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error("business date must be YYYY-MM-DD");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const current = new Date(Date.UTC(year, month - 1, day));
  if (
    current.getUTCFullYear() !== year ||
    current.getUTCMonth() !== month - 1 ||
    current.getUTCDate() !== day
  ) {
    throw new Error("business date must be a real calendar date");
  }

  current.setUTCDate(current.getUTCDate() + 1);
  return `${current.getUTCFullYear()}-${pad(current.getUTCMonth() + 1)}-${pad(current.getUTCDate())}`;
}

function finiteMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Counts review states and only applies effects explicitly confirmed by a
 * parent. A pending/unknown/non-finite value never creates a reward or debit.
 */
export function summarizeActivityDay(rows: ActivityDayRow[]): ActivityDaySummary {
  return rows.reduce<ActivityDaySummary>(
    (summary, row) => {
      summary.total += 1;
      if (row.child_reported) summary.reported += 1;

      if (row.verification_status === "CONFIRMED") {
        summary.confirmed += 1;
        const minutes = finiteMinutes(row.confirmed_minutes);
        if (minutes !== null) {
          summary.signedMinutes += minutes;
          if (minutes > 0) summary.positiveMinutes += minutes;
        }
      } else if (row.verification_status === "HELD") {
        summary.held += 1;
      } else if (row.verification_status === "MISSING") {
        summary.missing += 1;
      }

      return summary;
    },
    {
      total: 0,
      reported: 0,
      confirmed: 0,
      held: 0,
      missing: 0,
      positiveMinutes: 0,
      signedMinutes: 0,
    },
  );
}

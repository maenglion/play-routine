export type OctoberAsset = "MINUTES" | "CASH_KRW" | "COUPAY_KRW";
export type OctoberStickerAsset = "SCHOOL_BASIC" | "SCHOOL_PRAISE";
export type OctoberDomain = "TASK" | "QUEST" | "LIFESTYLE";
export type OctoberState =
  | "UNCONFIRMED"
  | "SELF_REPORTED"
  | "PASS"
  | "NO_PASS"
  | "PENALTY"
  | "NO_VIOLATION"
  | "LIMIT_EXCEEDED"
  | "REVIEW_REQUIRED";
export type OctoberEffect = {
  asset: OctoberAsset | OctoberStickerAsset;
  quantity: number | null;
};
export type OctoberRule = {
  id: string;
  code: string;
  domain: OctoberDomain;
  name: string;
  criteria: string;
  schedule_label: string;
  effect_kind: "REWARD" | "PENALTY" | "SCHOOL";
  daily_limit: number | null;
  period: "DAILY" | "WEEKLY" | "MONTHLY" | "EVENT";
  effects: OctoberEffect[];
  pending_fields: string[];
  condition_spec: Record<string, unknown>;
};
export type OctoberRow = {
  id: string;
  rule_id: string;
  code: string;
  date: string;
  slot: string;
  revision: number;
  state: OctoberState;
  self_reported: boolean;
  confirmed_at: string | null;
  reason: string | null;
  metrics: Record<string, unknown>;
  effects: OctoberEffect[];
  recognized_count: number;
};
export type OctoberRight = {
  id: string;
  code: string;
  rule_name: string;
  asset: OctoberAsset;
  quantity: number;
  fulfilled_quantity: number;
  status: "ISSUED" | "REVIEW_REQUIRED" | "VOIDED";
  source_date: string;
  issued_at: string;
};
export type OctoberSummary = {
  pending_minutes: number;
  penalty_minutes: number;
  unconfirmed: number;
};
export type OctoberBoard = {
  plan: null | {
    id: string;
    month: string;
    effective_from: string;
    status: "ACTIVE";
    school_asset: OctoberAsset | "PENDING";
  };
  rules: OctoberRule[];
  rows: OctoberRow[];
  rights: OctoberRight[];
  summary: OctoberSummary;
};

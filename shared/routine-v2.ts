export type RoutineFlow = "DAILY" | "QUEST";
export type RoutinePeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "SPECIAL_EVENT";
export type ReinforcerUnit = "WON" | "MIN" | "POINT" | "STRING";
export type StickerIcon = "STAR" | "SMILE" | "STAMP";
export type RoutineCategory =
  | "DAILY_STUDY"
  | "SPECIAL_SCHEDULE"
  | "LIFE_HABIT"
  | "OTHER";
export type RoutineRewardInput = {
  id: string;
  reinforcerId: string;
  amount: number | null;
  text: string;
};
export type RoutineTierInput = {
  id: string;
  label: string;
  threshold: number | null;
  operator: "GTE" | "GT";
  rewards: RoutineRewardInput[];
};
export type RoutineDraftPayload = {
  schemaVersion: 1;
  flow: RoutineFlow;
  name: string;
  category: RoutineCategory;
  childLabel: string;
  criteria: string;
  stickerIcon: StickerIcon;
  measurement: "STICKER" | "PERCENT" | "QUANTITY";
  period: RoutinePeriod;
  penaltyLimit: number | null;
  penaltyMinutes: number;
  tiers: RoutineTierInput[];
};
export type RoutineDraftRow = {
  id: string;
  family_id: string;
  source_rule_id: string | null;
  step: number;
  revision: number;
  payload: RoutineDraftPayload;
  status: "DRAFT" | "PUBLISHED";
  published_rule_id: string | null;
  effective_from: string | null;
  updated_at: string;
};
export type ReinforcerRow = {
  id: string;
  name: string;
  unit: ReinforcerUnit;
  unit_label: string;
};
export type RoutineRuleRow = {
  id: string;
  family_id: string;
  subject_ref_id: string;
  name: string;
  effective_from: string;
  version: number;
  payload: RoutineDraftPayload;
};
export type RoutineAssignmentRow = {
  id: string;
  rule_id: string;
  child_profile_id: string;
  child_name: string;
  rule_name: string;
  flow: RoutineFlow;
  starts_on: string;
  ends_on: string | null;
  weekdays: number[];
  repeat: "DAILY" | "ONCE";
};
export type RoutineRewardView = {
  id: string;
  name: string;
  unit: ReinforcerUnit;
  unit_label: string;
  amount: number | null;
  text: string;
};
export type RoutineTierView = {
  id: string;
  label: string;
  threshold: number;
  operator: "GTE" | "GT";
  reached: boolean;
  rewards: RoutineRewardView[];
};
export type RoutineDayRow = {
  id: string;
  assignment_id: string;
  rule_id: string;
  business_date: string;
  name: string;
  child_label: string;
  criteria: string;
  category: RoutineCategory;
  flow: RoutineFlow;
  sticker_icon: StickerIcon;
  period: RoutinePeriod;
  measurement?: "STICKER" | "PERCENT" | "QUANTITY";
  period_start: string;
  period_end: string;
  period_closed: boolean;
  child_reported: boolean;
  verification_status: "MISSING" | "HELD" | "CONFIRMED";
  score: number | null;
  pass: boolean | null;
  praise: boolean;
  stickers: number | null;
  sticker_total: number;
  revision: number;
  parent_reason: string | null;
  parent_verified_at: string | null;
  penalty_minutes: number | null;
  tiers: RoutineTierView[];
};
export type RoutineEntitlementRow = {
  id: string;
  child_profile_id: string;
  rule_id: string;
  rule_name: string;
  condition_label: string;
  source_date: string;
  period_start: string;
  period_end: string;
  name: string;
  unit: ReinforcerUnit;
  unit_label: string;
  amount: number | null;
  text: string;
  status: "AVAILABLE" | "FULFILLED" | "REVIEW_REQUIRED";
  requires_review?: boolean;
  created_at: string;
  fulfilled_at: string | null;
};

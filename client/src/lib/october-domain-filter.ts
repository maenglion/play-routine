import type { OctoberBoard, OctoberDomain } from "@shared/october-runtime";
export type OctoberDomainFilter = "ALL" | OctoberDomain;
export function octoberDomainFilterValue(
  value: string | null | undefined
): OctoberDomainFilter {
  return value === "TASK" || value === "QUEST" || value === "LIFESTYLE"
    ? value
    : "ALL";
}
export function octoberDomainFilterFromSearch(
  search: string
): OctoberDomainFilter {
  return octoberDomainFilterValue(new URLSearchParams(search).get("kind"));
}
export function octoberDomainFilterSearch(
  search: string,
  filter: OctoberDomainFilter
): string {
  const params = new URLSearchParams(search);
  if (filter === "ALL") params.delete("kind");
  else params.set("kind", filter);
  const value = params.toString();
  return value ? `?${value}` : "";
}
/** A display projection only. Never changes the board snapshot, summaries or RPC payloads. */
export function filterOctoberBoardByDomain(
  board: OctoberBoard | null,
  filter: OctoberDomainFilter
) {
  const rules = (board?.rules ?? []).filter(
    r => filter === "ALL" || r.domain === filter
  );
  const ids = new Set(rules.map(r => r.id)),
    codes = new Set(rules.map(r => r.code));
  return {
    rules,
    rows: (board?.rows ?? []).filter(
      r => filter === "ALL" || ids.has(r.rule_id)
    ),
    rights: (board?.rights ?? []).filter(
      r => filter === "ALL" || codes.has(r.code)
    ),
  };
}

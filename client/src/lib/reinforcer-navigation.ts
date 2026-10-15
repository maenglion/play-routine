/** 등록 영역은 항상 마운트돼 있으므로 탭·초안 상태를 바꾸지 않는다. */
export function focusReinforcerRegistration(
  root: Pick<Document, "getElementById"> = document
): boolean {
  const section = root.getElementById("parent-reinforcers");
  if (!section) return false;
  section.scrollIntoView({ behavior: "auto", block: "start" });
  root
    .getElementById("reinforcer-registration-title")
    ?.focus({ preventScroll: true });
  return true;
}

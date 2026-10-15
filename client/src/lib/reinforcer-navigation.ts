/** 폼은 접어도 마운트 상태를 유지하므로 초안·카탈로그·입력값은 초기화하지 않는다. */
export function focusReinforcerRegistration(
  root: Pick<Document, "getElementById"> = document
): boolean {
  const section = root.getElementById("parent-reinforcers");
  if (!section) return false;
  const form = root.getElementById("reinforcer-registration-form");
  if (form && "open" in form) (form as HTMLDetailsElement).open = true;
  section.scrollIntoView({ behavior: "auto", block: "start" });
  root
    .getElementById("reinforcer-registration-title")
    ?.focus({ preventScroll: true });
  return true;
}

export function openParentSettings(
  id: string,
  root: Pick<Document, "getElementById"> = document
): boolean {
  const section = root.getElementById(id);
  if (!section) return false;
  if ("open" in section) (section as HTMLDetailsElement).open = true;
  section.scrollIntoView({ behavior: "auto", block: "start" });
  section.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  return true;
}

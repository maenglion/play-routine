const messages: Record<string, string> = {
  ROUTINE_FLOW_MEASUREMENT_PERIOD_MISMATCH:
    "Quest의 내부 기간값이 맞지 않습니다. ‘이어쓰기’로 열고 임시저장한 뒤 게시해 주세요. 기준과 보상은 유지됩니다.",
  ROUTINE_DRAFT_REVISION_CONFLICT:
    "다른 화면에서 초안이 갱신됐습니다. 저장한 초안 목록을 새로고침하고 이어쓰기 해 주세요.",
  ROUTINE_REVISION_CONFLICT:
    "초안의 수정 번호가 바뀌었습니다. 목록을 새로고침하고 이어쓰기 해 주세요.",
  ROUTINE_PUBLISH_REQUIRES_TEXT:
    "활동 이름·아이 표시 키워드·부모 확인 기준을 모두 입력해 주세요.",
  ROUTINE_REINFORCER_NOT_IN_FAMILY_CATALOG:
    "선택한 강화물을 현재 가족 목록에서 찾지 못했습니다. 목록을 새로고침하고 다시 선택해 주세요.",
  ROUTINE_NUMERIC_REWARD_REQUIRES_AMOUNT_ONLY:
    "금액·시간 보상은 유효한 정수로 입력해 주세요. 시간은 1~240분입니다.",
  ROUTINE_PUBLISHED_DRAFT_IMMUTABLE:
    "이미 게시한 초안은 수정할 수 없습니다. 새 버전으로 등록해 주세요.",
  ROUTINE_ACCESS_REQUIRED: "부모 로그인과 가족 접근 권한을 다시 확인해 주세요.",
};

/** PostgREST 오류는 Error 인스턴스가 아닌 객체다. 원문 SQL·details·이메일은 표시하지 않는다. */
export function routineErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const value = error as { message?: unknown; code?: unknown };
  const message = typeof value.message === "string" ? value.message : "";
  for (const [key, explanation] of Object.entries(messages)) {
    if (message.includes(key)) return explanation;
  }
  const code = typeof value.code === "string" ? value.code : "";
  if (code === "40001") return messages.ROUTINE_DRAFT_REVISION_CONFLICT;
  if (code === "42501" || code === "PGRST301" || code === "PGRST303")
    return messages.ROUTINE_ACCESS_REQUIRED;
  return /^[A-Z0-9]{5}$|^PGRST\d{3}$/.test(code)
    ? `${fallback} (오류 코드: ${code})`
    : fallback;
}

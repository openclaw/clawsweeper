/** Closed recorder data contract; intentionally excludes the userbot command/config DSL. */
export function validFixedWebUiProofPlan(value: unknown): value is { kind: "web-ui-chat-smoke" } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).kind === "web-ui-chat-smoke"
  );
}

export function validReviewProofPlan(value: unknown): value is Record<string, unknown> {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  const integer = (v: unknown, min: number, max: number): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
  if (
    !object(value) ||
    !exact(value, [
      "claim",
      "actions",
      "modelReplies",
      "settings",
      "maxDurationMs",
      "expectations",
    ]) ||
    !text(value.claim, 1024) ||
    !integer(value.maxDurationMs, 1000, 90_000) ||
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > 8 ||
    !Array.isArray(value.modelReplies) ||
    value.modelReplies.length > 8 ||
    !value.modelReplies.every((v) => text(v, 4096)) ||
    !Array.isArray(value.expectations) ||
    value.expectations.length < 1 ||
    value.expectations.length > 8 ||
    !value.expectations.every((v) => text(v, 1024)) ||
    !object(value.settings) ||
    !exact(value.settings, ["streaming", "nativeCommands"]) ||
    !["off", "partial", "block"].includes(String(value.settings.streaming)) ||
    typeof value.settings.nativeCommands !== "boolean"
  )
    return false;
  let previous = 0;
  for (const [index, action] of value.actions.entries()) {
    if (
      !object(action) ||
      !integer(action.atMs, previous, 60_000) ||
      (index === 0 && action.type !== "send")
    )
      return false;
    if (action.type === "send") {
      if (
        !exact(action, ["type", "atMs", "text"]) ||
        !text(action.text, 4096) ||
        action.atMs >= value.maxDurationMs
      )
        return false;
    } else if (action.type === "click") {
      if (
        !exact(action, ["type", "atMs", "messageText", "buttonText", "timeoutMs"]) ||
        !text(action.messageText, 4096) ||
        !text(action.buttonText, 256) ||
        !integer(action.timeoutMs, 1, 10_000) ||
        action.atMs + action.timeoutMs >= value.maxDurationMs
      )
        return false;
    } else return false;
    previous = action.atMs;
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 48 * 1024;
}

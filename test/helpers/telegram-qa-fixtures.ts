export function telegramQaFiles(
  identity: { requestId: string; headSha: string; harnessSha: string; runId?: string },
  outcome: "pass" | "fail",
) {
  const scenario = "telegram-markdown-parser-fidelity";
  const cases = [
    "all-space-code",
    "unclosed-link-label",
    "ipv6-link",
    "table-code-leading-space",
  ].map((name, index) => ({
    case: name,
    messageId: String(index + 1),
    expectedHtml: "<code>fixture</code>",
    outboundHtml: outcome === "fail" && index === 0 ? "incorrect" : "<code>fixture</code>",
    acceptedPayloads: [
      {
        text: outcome === "fail" && index === 0 ? "incorrect" : "<code>fixture</code>",
        parseMode: "HTML",
      },
    ],
  }));
  return new Map(
    Object.entries({
      "qa-execution.json": {
        schema: "mantis.telegram-qa-execution.v1",
        request_id: identity.requestId,
        candidate_sha: identity.headSha,
        harness_sha: identity.harnessSha,
        run_id: identity.runId ?? "300",
        run_attempt: 1,
        scenario,
        transport: "Crabline",
        live_service: false,
        candidate_quiescent: true,
      },
      "qa-result.json": {
        schema: "mantis.telegram-qa-result.v1",
        scenario,
        status: outcome,
        steps: [
          { name: "preserves four exact Markdown payloads through Gateway send", status: outcome },
        ],
      },
      "qa-observations.json": { schema: "mantis.telegram-qa-observations.v1", scenario, cases },
    }).map(([name, value]) => [name, Buffer.from(JSON.stringify(value))]),
  );
}

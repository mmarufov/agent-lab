import type { SavedReview } from "./reviews";

// Terminal lines for one saved review attempt. pnpm lab:review prints them
// when its attempt ends, and pnpm lab review prints the same lines from the
// saved record, so a reopened review reads like the live one without another
// model request.

const count = (value: number) => value.toLocaleString("en-US");

function describeInput(saved: SavedReview) {
  const bytes = Buffer.byteLength(JSON.stringify(saved.input), "utf8");
  const size = `${count(bytes)} of ${count(saved.configuration.settings.maxInputBytes)} bytes`;
  if (saved.source === "simulated") return `Input: ${saved.input.evidence.length} log record(s), ${size}`;
  const { evidence, untimedEvidence } = saved.input;
  const http = evidence.filter((record) => record.kind === "http").length;
  return `Input: ${evidence.length + untimedEvidence.length} record(s): ${http} HTTP observation(s), ${evidence.length - http} timed and ${untimedEvidence.length} untimed log line(s); ${size}`;
}

export function describeReview(saved: SavedReview): string[] {
  const { configuration, observation, review } = saved;
  const resolved = observation?.resolvedModelId && observation.resolvedModelId !== configuration.modelId ? ` (responded as ${observation.resolvedModelId})` : "";
  const lines = [
    `Run: ${saved.runId}`,
    saved.source === "daily_capture"
      ? `Source: recorded Daily capture ${saved.input.captureId} (evidence.jsonl ${saved.input.evidenceSha256})`
      : `Source: simulated deployment ${saved.input.deploymentId}`,
    `Status: ${saved.status}`,
    `Reviewer: ${configuration.modelId}${resolved}, prompt ${configuration.promptVersion} (SHA-256 ${saved.promptHash})`,
    `Started: ${saved.startedAt}`,
    `Finished: ${saved.finishedAt ?? "not recorded"}`,
    `Duration: ${saved.durationMs === null ? "not recorded" : `${count(Math.round(saved.durationMs))} ms`}`,
    describeInput(saved),
    "",
    saved.source === "daily_capture"
      ? `Evidence checks (${saved.evidenceCheck.evaluatorVersion}), frozen when the investigation finished and reproduced from its saved events before this review:`
      : `Evidence checks (${saved.evidenceCheck.evaluatorVersion}), computed from the saved events before this review:`,
  ];
  // Saved as jsonb, which does not keep key order.
  for (const name of ["execution", "answer", "toolTrace", "retrieval", "citations"] as const) {
    const check = saved.evidenceCheck.checks[name];
    lines.push(`${check.status.toUpperCase()} ${name}: ${check.reason}`);
  }
  lines.push(`Cited IDs: ${saved.evidenceCheck.citedEvidenceIds.join(", ") || "none assessed"}`, "");

  lines.push("Answer support review. Coverage of evidence not retrieved is not assessed.");
  if (review) {
    const verdicts = (["supported", "unsupported", "uncertain"] as const).map(
      (verdict) => `${review.claims.filter((claim) => claim.verdict === verdict).length} ${verdict}`,
    );
    lines.push(`Claims: ${verdicts.join(", ")}.`);
    for (const claim of review.claims) {
      lines.push("", `${claim.verdict.toUpperCase()} [${claim.field}] "${claim.quote}"`, `  ${claim.explanation}`, `  Evidence: ${claim.evidenceIds.join(", ") || "none cited"}`);
    }
    lines.push("", "Missing evidence:", ...(review.missingEvidence.length ? review.missingEvidence.map((item) => `  - ${item}`) : ["  none identified"]));
    lines.push(`Summary: ${review.summary}`);
  } else {
    lines.push(saved.status === "running"
      ? "No final assessment is saved. This review may still be active or may have been interrupted."
      : "No valid assessment was saved.");
  }

  const usage = observation?.usage;
  lines.push("", usage
    ? `Review usage: ${usage.inputTokens === null ? "unknown" : count(usage.inputTokens)} input, ${usage.outputTokens === null ? "unknown" : count(usage.outputTokens)} output tokens; ` +
      (usage.costUsd === null ? "reported cost unknown" : `reported cost $${usage.costUsd.toFixed(6)}`)
    : "Review usage: not reported; no model response was recorded");
  if (saved.error) lines.push(`Error: ${saved.error}`);
  lines.push("The model review is advisory. It does not override the evidence checks, and a supported claim does not prove the diagnosis.");
  return lines;
}

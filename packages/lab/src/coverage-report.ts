import type { CoverageStatus } from "./coverage";
import type { SavedCoverageAssessment } from "./daily-coverage";
import { describeIntegrity } from "./runs";

// Terminal lines for one saved coverage assessment. pnpm lab:coverage prints
// them after saving or finding the assessment, and pnpm lab coverage prints
// the same lines from the saved record alone.

const label: Record<CoverageStatus, string> = { covered: "covered", missed: "missed", not_assessed: "not assessed" };
const list = (ids: readonly string[]) => ids.join(", ");

export function describeCoverage(saved: SavedCoverageAssessment): string[] {
  const { integrity, scope, retrieved } = saved;
  const lines = [
    `Coverage assessment: ${saved.id}`,
    `Run: ${saved.runId}`,
    `Source: recorded Daily capture ${saved.captureId} (evidence.jsonl ${saved.captureSha256["evidence.jsonl"]})`,
    `Profile: ${saved.profileVersion}, evaluator ${saved.evaluatorVersion}`,
    `Assessed: ${saved.assessedAt}`,
    describeIntegrity({ status: "verified", fingerprint: integrity, currentSha256: integrity.sha256, currentEventCount: integrity.eventCount }),
    `Recording: ${scope.feedObservations} authenticated GET /feed observation(s): ${scope.serverErrors} server error(s), ${scope.noResponses} without a response, ` +
      `${scope.readyResponses} ready response(s), ${scope.otherResponses} other.`,
    retrieved.counted
      ? `Retrieved before the answer: ${retrieved.records} distinct record(s), ${retrieved.httpObservations} of them HTTP observations, each identical to the recorded record.`
      : "Retrieved before the answer: not counted; this investigation cannot be assessed.",
    "",
  ];
  for (const fact of saved.facts) {
    lines.push(`${fact.label}: ${label[fact.status]}`);
    if (!fact.requirements.length || (fact.status === "not_assessed" && !retrieved.counted)) lines.push(`  ${fact.reason}`);
    for (const requirement of fact.requirements) {
      lines.push(`  Needs ${requirement.description}.`);
      if (!retrieved.counted) lines.push(`    Acceptable: ${list(requirement.anyOf)}`);
      else if (requirement.matchedIds.length) lines.push(`    Retrieved: ${list(requirement.matchedIds)}`);
      else lines.push(`    Missing: none of these acceptable records was retrieved: ${list(requirement.anyOf)}`);
    }
  }
  lines.push(
    "Answer interpretation: not assessed by this coverage check",
    "",
    `Result: ${label[saved.result]}. ${saved.reason}`,
    "Coverage shows only whether the investigator retrieved, cited or not, recorded HTTP observations that establish these facts before answering. " +
      "It does not assess the diagnosis, whether the answer states these facts, root-cause logs, or health after the recording. " +
      "Recovery means a sampled success within the recording, not continuous or current health.",
  );
  return lines;
}

/** 0 covered, 1 missed, 2 not assessed: the same convention as pnpm lab evaluate. */
export const coverageExitCode = (result: CoverageStatus) => (result === "covered" ? 0 : result === "missed" ? 1 : 2);

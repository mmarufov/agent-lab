import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { compareTimestamps } from "@agent-lab/contracts/daily-review";
import { COVERAGE_EVALUATOR_VERSION, evaluateCoverage, unassessedCoverage, type CoverageFact, type CoverageResult } from "./coverage";
import { readDailyEvidence, type ReceivedRecord } from "./daily-evaluate";
import { DailyCaptureError, EVIDENCE, dailyCapturesDir, readDailyCapture, type CaptureFileHashes, type DailyCaptureRecords } from "./daily-evidence";
import { createRunStore, requireVerifiedIntegrity, type DailyRun } from "./runs";

// Evidence coverage of one finished Daily investigation: which availability
// facts of the full recording the investigator retrieved records for before
// answering. The facts come from the recording's own contents and times, never
// from the controller or from assuming the outage made every request fail. No
// model, Docker, Eve, or Next.js is involved, and nothing here is given to the
// investigator or to the evidence-only reviewer.

export const DAILY_FEED_AVAILABILITY_PROFILE = "daily-feed-availability-v1";

const isFeedRequest = (observation: DailyHttpObservation) =>
  observation.method === "GET" && observation.path === "/feed" && observation.authenticated;
const isServerError = (observation: DailyHttpObservation) =>
  observation.outcome === "response" && observation.response.status >= 500 && observation.response.status <= 599;
const isNoResponse = (observation: DailyHttpObservation) => observation.outcome === "timeout" || observation.outcome === "network_error";

/** HTTP 200 with an untruncated JSON body whose status is "ready" and that has an articles array. */
function isReadyFeed(observation: DailyHttpObservation) {
  if (observation.outcome !== "response") return false;
  const { status, bodyFormat, bodyTruncated, body } = observation.response;
  const json = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  return status === 200 && bodyFormat === "json" && !bodyTruncated && json?.status === "ready" && Array.isArray(json.articles);
}

/**
 * daily-feed-availability-v1: authenticated GET /feed observations of the full
 * recording, and which of them establish each fact. A failure is a 500-599
 * response, a timeout, or a network error; any other response, such as an
 * authentication failure or a truncated body, establishes none of the facts.
 * Recovery needs a failure and a ready response to a request that started
 * after the recording's last failure ended, so an earlier success, or one
 * followed by more failures, cannot stand in for it.
 */
export function dailyFeedAvailabilityFacts(observations: readonly DailyHttpObservation[]) {
  const feed = observations.filter(isFeedRequest);
  const serverErrors = feed.filter(isServerError);
  const noResponses = feed.filter(isNoResponse);
  const failures = feed.filter((observation) => isServerError(observation) || isNoResponse(observation));
  const ready = feed.filter(isReadyFeed);
  const lastFailureEndedAt = failures.reduce<string | null>(
    (latest, failure) => (latest === null || compareTimestamps(failure.endedAt, latest) > 0 ? failure.endedAt : latest), null);
  const recovered = lastFailureEndedAt === null ? [] : ready.filter((success) => compareTimestamps(success.startedAt, lastFailureEndedAt) > 0);
  const ids = (list: DailyHttpObservation[]) => list.map((observation) => observation.id);

  const serverError = { id: "server_errors", label: "Server-error evidence", statement: "Server errors occurred" };
  const noResponse = { id: "no_response", label: "No-response evidence", statement: "Requests received no response" };
  const recovery = { id: "recovery", label: "Recovery evidence", statement: "Requests subsequently recovered" };
  const facts: CoverageFact[] = [
    serverErrors.length
      ? { ...serverError, applicable: true, requirements: [{ id: "server_error", description: "an authenticated GET /feed response with status 500-599", anyOf: ids(serverErrors) }] }
      : { ...serverError, applicable: false, reason: "The recording has no authenticated GET /feed response with status 500-599." },
    noResponses.length
      ? { ...noResponse, applicable: true, requirements: [{ id: "no_response", description: "an authenticated GET /feed request that timed out or failed with a network error", anyOf: ids(noResponses) }] }
      : { ...noResponse, applicable: false, reason: "The recording has no authenticated GET /feed request that timed out or failed with a network error." },
    !failures.length
      ? { ...recovery, applicable: false, reason: "The recording has no failed authenticated GET /feed request to recover from." }
      : !recovered.length
        ? { ...recovery, applicable: false, reason: `No ready authenticated GET /feed response came from a request started after the recording's last failed request ended at ${lastFailureEndedAt}, so the recording does not show recovery.` }
        : {
            ...recovery, applicable: true, requirements: [
              { id: "failure", description: "a failed authenticated GET /feed request: status 500-599, a timeout, or a network error", anyOf: ids(failures) },
              {
                id: "later_success",
                description: `a ready authenticated GET /feed response (HTTP 200, untruncated JSON with status "ready" and an articles array) to a request started after the recording's last failed request ended at ${lastFailureEndedAt}`,
                anyOf: ids(recovered),
              },
            ],
          },
  ];
  const acceptable = new Set(ids([...failures, ...recovered]));
  return {
    facts,
    /** Every recorded observation a requirement accepts, complete and in recorded order. */
    acceptableEvidence: feed.filter((observation) => acceptable.has(observation.id)),
    scope: {
      feedObservations: feed.length,
      serverErrors: serverErrors.length,
      noResponses: noResponses.length,
      readyResponses: ready.length,
      otherResponses: feed.length - failures.length - ready.length,
      lastFailureEndedAt,
    },
  };
}

export interface DailyCoverageAssessment {
  profileVersion: typeof DAILY_FEED_AVAILABILITY_PROFILE;
  evaluatorVersion: typeof COVERAGE_EVALUATOR_VERSION;
  runId: string;
  captureId: string;
  /** The files the run's grant pinned, verified again before the recording was read. */
  captureSha256: CaptureFileHashes;
  /** The run's fingerprint, verified before anything was computed. */
  integrity: NonNullable<DailyRun["integrity"]["fingerprint"]>;
  result: CoverageResult["result"];
  reason: string;
  scope: ReturnType<typeof dailyFeedAvailabilityFacts>["scope"];
  facts: CoverageResult["facts"];
  acceptableEvidence: DailyHttpObservation[];
  /** What the investigation received before its answer; not counted when it could not be assessed. */
  retrieved: { counted: boolean; records: number; httpObservations: number; matches: ReceivedRecord[] };
  investigation: { status: DailyRun["status"]; evidenceEvaluator: string; checks: Record<"execution" | "answer" | "toolTrace", { status: string; reason: string }> };
  answerInterpretation: { status: "not_assessed"; reason: string };
}

export interface SavedCoverageAssessment extends DailyCoverageAssessment {
  id: string;
  assessedAt: string;
}

/**
 * The daily-feed-availability-v1 assessment of a finished run against its full,
 * verified recording. The records counted are the ones the frozen evidence
 * report counts, cited or not, and each must equal the recorded record in
 * full. A mismatch throws: it can never become a grade.
 */
export function assessDailyFeedAvailability(run: DailyRun, capture: DailyCaptureRecords): DailyCoverageAssessment {
  const integrity = requireVerifiedIntegrity(run, "No coverage assessment was saved");
  if (capture.captureId !== run.captureId || !isDeepStrictEqual(capture.sha256, run.captureSha256))
    throw new Error(`The recording supplied is not the one run ${run.id} read. No coverage assessment was saved.`);
  const { report, records } = readDailyEvidence({ ...run, evidenceSha256: run.captureSha256[EVIDENCE] });
  if (!run.evidenceReport || !isDeepStrictEqual(report, run.evidenceReport))
    throw new Error(`The saved events of run ${run.id} no longer produce the evidence report frozen when it finished. No coverage assessment was saved; inspect it with pnpm lab evaluate ${run.id}.`);

  const profile = dailyFeedAvailabilityFacts(capture.observations);
  const { execution, answer, toolTrace } = report.checks;
  const unassessable = execution.status !== "pass"
    ? `The investigation ${run.status === "cancelled" ? "was cancelled" : "failed"}; coverage is assessed only for a completed investigation.`
    : answer.status !== "pass" ? `${answer.reason} Which records came before the answer is therefore unknown.`
      : toolTrace.status !== "pass" ? `The evidence trace is invalid: ${toolTrace.reason}`
        : null;

  let coverage: CoverageResult;
  let matches: ReceivedRecord[] = [];
  if (unassessable) coverage = unassessedCoverage(profile.facts, unassessable);
  else {
    const recorded = new Map([...capture.observations, ...capture.logs].map((record) => [record.id, record]));
    const problems = records.flatMap((record) => {
      const original = recorded.get(record.id);
      if (!original) return [`${record.id} is not in the recording`];
      return isDeepStrictEqual(original, record) ? [] : [`${record.id} differs from the recorded ${record.kind === "http" ? "observation" : "log line"}`];
    });
    if (problems.length)
      throw new Error(`Run ${run.id} retrieved records that differ from capture ${run.captureId}: ${problems.join("; ")}. No coverage assessment was saved.`);
    coverage = evaluateCoverage(profile.facts, records.map((record) => record.id));
    const matched = new Set(coverage.facts.flatMap((fact) => fact.requirements.flatMap((requirement) => requirement.matchedIds)));
    matches = report.retrievedEvidence.filter((received) => matched.has(received.id));
  }
  const summary = (check: { status: string; reason: string }) => ({ status: check.status, reason: check.reason });
  return {
    profileVersion: DAILY_FEED_AVAILABILITY_PROFILE,
    evaluatorVersion: coverage.evaluatorVersion,
    runId: run.id,
    captureId: run.captureId,
    captureSha256: run.captureSha256,
    integrity,
    result: coverage.result,
    reason: coverage.reason,
    scope: profile.scope,
    facts: coverage.facts,
    acceptableEvidence: profile.acceptableEvidence,
    retrieved: {
      counted: !unassessable,
      records: unassessable ? 0 : records.length,
      httpObservations: unassessable ? 0 : records.filter((record) => record.kind === "http").length,
      matches,
    },
    investigation: { status: run.status, evidenceEvaluator: report.evaluatorVersion, checks: { execution: summary(execution), answer: summary(answer), toolTrace: summary(toolTrace) } },
    answerInterpretation: {
      status: "not_assessed",
      reason: "This coverage check does not read the answer. Whether its diagnosis is right, or states these facts, is not assessed.",
    },
  };
}

// Trusted controller access only, like the run and review stores.
export function createCoverageStore(pool: Pool) {
  async function read(where: string, values: unknown[]) {
    const result = await pool.query<{ id: string; assessment: DailyCoverageAssessment; assessedAt: Date }>(
      `SELECT id, assessment, assessed_at AS "assessedAt" FROM lab_coverage_assessments ${where}`, values);
    const row = result.rows[0];
    return row ? { ...row.assessment, id: row.id, assessedAt: row.assessedAt.toISOString() } satisfies SavedCoverageAssessment : null;
  }

  const store = {
    /**
     * Assesses a finished Daily run, resolving 'latest' once, and saves the
     * result. The same run, profile, and evaluator version have one assessment:
     * repeating returns it after checking the recording still reproduces it.
     */
    async assess(runId: string, options: { capturesDir?: string } = {}) {
      const run = await createRunStore(pool).getAny(runId);
      if (run.source !== "daily_capture") {
        throw new Error(`Investigation ${run.id} is a simulated deployment run. Coverage profile ${DAILY_FEED_AVAILABILITY_PROFILE} assesses recorded Daily capture runs only; check simulated runs with pnpm lab evaluate ${run.id}.`);
      }
      requireVerifiedIntegrity(run, "No coverage assessment was saved");
      let capture: DailyCaptureRecords;
      try {
        capture = await readDailyCapture(options.capturesDir ?? dailyCapturesDir(), run.captureId, run.captureSha256);
      } catch (error) {
        if (error instanceof DailyCaptureError)
          throw new Error(`Coverage needs the recording run ${run.id} read. ${error.message} No coverage assessment was saved.`);
        throw error;
      }
      const assessment = assessDailyFeedAvailability(run, capture);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO lab_coverage_assessments
           (id, run_id, profile_version, evaluator_version, integrity_version, integrity_sha256, capture_id,
            capture_manifest_sha256, capture_evidence_sha256, capture_controller_sha256, result, assessment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (run_id, profile_version, evaluator_version) DO NOTHING RETURNING id`,
        [randomUUID(), run.id, assessment.profileVersion, assessment.evaluatorVersion, assessment.integrity.version, assessment.integrity.sha256,
          run.captureId, run.captureSha256["manifest.json"], run.captureSha256["evidence.jsonl"], run.captureSha256["controller.jsonl"],
          assessment.result, JSON.stringify(assessment)],
      );
      if (inserted.rows[0]) return { created: true, assessment: (await store.get(inserted.rows[0].id))! };
      const existing = await read("WHERE run_id = $1 AND profile_version = $2 AND evaluator_version = $3",
        [run.id, assessment.profileVersion, assessment.evaluatorVersion]);
      const { id, assessedAt, ...saved } = existing!;
      if (!isDeepStrictEqual(saved, JSON.parse(JSON.stringify(assessment)))) {
        throw new Error(`Coverage assessment ${id} of run ${run.id} under ${assessment.profileVersion} and ${assessment.evaluatorVersion} differs from what these rules compute now. Changed rules need a new profile or evaluator version; the saved assessment is unchanged.`);
      }
      return { created: false, assessment: { ...saved, id, assessedAt } as SavedCoverageAssessment };
    },

    /** A saved assessment, read from PostgreSQL alone: no capture files, Eve, or model. */
    async get(id: string) {
      const saved = id === "latest"
        ? await read("ORDER BY assessed_at DESC, id DESC LIMIT 1", [])
        : await read("WHERE id = $1", [id]);
      if (!saved) throw new Error("Coverage assessment not found.");
      return saved;
    },
  };
  return store;
}

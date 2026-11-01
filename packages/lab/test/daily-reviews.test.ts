import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewConfig, ReviewObservation, ReviewSource } from "@agent-lab/contracts";
import type { DailyApplicationLog, DailyCaptureEvidence } from "@agent-lab/contracts/daily-capture";
import type { DailyInvestigationAnswer } from "@agent-lab/contracts/daily-investigation";
import { createCaptureAccess } from "../src/capture-access";
import { createPool } from "../src/database";
import { createTrial } from "../src/fixtures";
import { createJobStore, JobError } from "../src/jobs";
import { migrate } from "../src/migrate";
import { createReviewStore, reviewSavedRun, type ReviewRequestOptions } from "../src/reviews";
import { createRunStore, UnsupportedRunSourceError } from "../src/runs";
import { createWebStore } from "../src/web";
import { bypassingTriggers } from "./administrator";
import { CLEAN_CAPTURE_ID, capturesDir, incidentEvidence, removeCaptureDirs, writeCapture } from "./daily-capture-fixture";

// Reviews of saved Daily investigations: what the reviewer receives, what each
// attempt saves, and what is refused before any model request. The model is a
// test function; nothing here contacts a provider, Daily, or a capture file.

const admin = createPool();
const schema = `daily_reviews_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
let grant: Awaited<ReturnType<ReturnType<typeof createCaptureAccess>["grant"]>>["grant"];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const dir = await capturesDir();
  await writeCapture(dir);
  ({ grant } = await createCaptureAccess(pool, dir).grant(CLEAN_CAPTURE_ID));
});
afterAll(async () => {
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const settings = { maxOutputTokens: 1000, maxRetries: 0 as const, timeoutMs: 1000, maxInputBytes: 65_536 };
const configs = {
  simulated: { source: "simulated", modelId: "test/reviewer", promptVersion: "test-v1", schemaVersion: 1, system: "Review a simulated run.", settings },
  daily_capture: { source: "daily_capture", modelId: "test/reviewer", promptVersion: "test-daily-v1", schemaVersion: 1, system: "Review a Daily run.", settings },
} satisfies Record<ReviewSource, ReviewConfig>;
const configure = (source: ReviewSource) => configs[source];
const observation: ReviewObservation = {
  responseId: "response-1", resolvedModelId: "test/reviewer", finishReason: "stop",
  usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200, costUsd: 0.001 },
};

const record = Object.fromEntries(incidentEvidence().map((value) => [value.id, value])) as Record<string, DailyCaptureEvidence>;
const pick = (...ids: string[]) => ids.map((id) => record[id]);
const shutdown = record["log-api-0003"] as DailyApplicationLog;
const answer: DailyInvestigationAnswer = {
  diagnosis: "/feed returned 500 errors while the API logged database AdminShutdown errors; later /feed requests succeeded again.",
  evidenceIds: ["http-0005", "log-api-0003", "http-0010"],
  uncertainty: "Why the database connection ended is not recorded, and nothing after the last sample is known.",
};
const assessment = {
  claims: [
    { field: "diagnosis", quote: "/feed returned 500 errors", verdict: "supported", evidenceIds: ["http-0005"], explanation: "http-0005 is a 500 response to /feed." },
    { field: "diagnosis", quote: "later /feed requests succeeded again", verdict: "supported", evidenceIds: ["http-0010"], explanation: "http-0010 is a later 200 response." },
    { field: "uncertainty", quote: "Why the database connection ended is not recorded", verdict: "supported", evidenceIds: [], explanation: "No supplied record explains it." },
  ],
  missingEvidence: ["Records after the last sample."],
  summary: "The symptoms and recovery are supported; the cause is qualified.",
};

let eventIds = 0;
const turn = { turnId: "turn_0", sequence: 0 };
const event = (type: string, data: object) => ({ type, meta: { id: `event-${++eventIds}`, at: "2026-10-30T00:00:00.000Z" }, data: { ...turn, ...data } });
const call = (callId: string, toolName: string, input: object, records: DailyCaptureEvidence[], output: object = {}) => [
  event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName, callId, input }] }),
  event("action.result", {
    status: "completed",
    result: {
      kind: "tool-result", toolName, callId,
      output: {
        captureId: grant.captureId, evidenceSha256: grant.sha256["evidence.jsonl"],
        [toolName === "get_daily_logs" ? "logs" : "observations"]: records, oversized: [], nextCursor: null, ...output,
      },
    },
  }),
];
const failedCall = (callId: string) => [
  event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId, input: { limit: 5 } }] }),
  event("action.result", {
    status: "failed", error: { code: "TOOL_ERROR", message: "PRIVATE TOOL FAILURE" },
    result: { kind: "tool-result", toolName: "get_daily_logs", callId, isError: true, output: "PRIVATE TOOL FAILURE" },
  }),
];
const reasoning = () => event("reasoning.completed", { reasoning: "PRIVATE REASONING about what to retrieve" });

/** A realistic investigation: two /feed pages that overlap, an error search, an unfiltered log page that repeats it, and a failed call. */
const investigation = () => [
  event("message.received", { message: "Investigate Daily's feed API." }),
  reasoning(),
  ...call("call-1", "get_daily_http_observations", { path: "/feed", limit: 2 }, pick("http-0002", "http-0005"), { nextCursor: "page-2" }),
  ...call("call-2", "get_daily_http_observations", { path: "/feed", cursor: "page-2" }, pick("http-0005", "http-0009", "http-0010")),
  ...call("call-3", "get_daily_logs", { messageContains: "error" }, pick("log-api-0002", "log-api-0003", "log-api-0004")),
  ...call("call-4", "get_daily_logs", { limit: 7 }, pick("log-api-0001", "log-api-0002", "log-api-0003", "log-api-0004", "log-api-0005", "log-gateway-0001", "log-api-0006")),
  ...failedCall("call-5"),
  event("step.completed", { stepIndex: 0, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }),
];

async function dailyRun(steps: object[], options: { answer?: DailyInvestigationAnswer; finish?: "completed" | "failed" | null } = {}) {
  const final = options.answer ?? answer;
  const finish = options.finish === undefined ? "completed" : options.finish;
  const id = await runs.createDaily({
    captureId: grant.captureId, grantId: grant.id, sha256: grant.sha256,
    task: "Investigate Daily's feed API during the recorded period.",
    instructions: "PRIVATE INVESTIGATOR INSTRUCTIONS", agentConfigSource: "PRIVATE AGENT SOURCE",
    configuration: { toolMode: "daily_capture", note: "PRIVATE CONFIGURATION" },
  });
  for (const step of [...steps, ...(finish === "completed" ? [event("result.completed", { result: final })] : [])]) await runs.appendEvent(id, step);
  if (finish === "completed") await runs.finish(id, { status: "completed", answer: final, message: "PRIVATE CHAT TEXT" });
  if (finish === "failed") await runs.finish(id, { status: "failed", error: "Eve stopped." });
  return id;
}

const respond = (review: unknown = assessment) => async (_input: unknown, { onResponse }: ReviewRequestOptions) => {
  await onResponse(observation);
  return review;
};
const attempts = async (runId: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM lab_investigation_reviews WHERE run_id = $1", [runId])).rows[0].n;

function cli(script: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { ...process.env, DATABASE_URL: url.toString(), ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

describe("reviewing a saved Daily investigation", () => {
  it("supplies every received record once, complete and in time order, and saves the exact attempt", async () => {
    const id = await dailyRun(investigation());
    const original = await runs.getDaily(id);
    const sources: ReviewSource[] = [];
    let supplied: unknown;
    let requested: ReviewConfig | undefined;
    const result = await reviewSavedRun(pool, id, (source) => (sources.push(source), configs[source]), async (input, request) => {
      supplied = input;
      requested = request.configuration;
      return respond()(input, request);
    });

    expect(sources).toEqual(["daily_capture"]);
    expect(result).toMatchObject({ status: "completed", source: "daily_capture", runId: id, configuration: configs.daily_capture, observation, review: assessment, error: null });
    // The request used the configuration saved with the attempt.
    expect(requested).toEqual(result.configuration);
    if (result.source !== "daily_capture") throw new Error("Expected a Daily review.");
    expect(result.input).toEqual(supplied);
    expect(Object.keys(result.input).sort()).toEqual(["answer", "captureId", "evidence", "evidenceSha256", "task", "untimedEvidence"]);
    expect(result.input).toMatchObject({ captureId: CLEAN_CAPTURE_ID, evidenceSha256: grant.sha256["evidence.jsonl"], answer, task: original.task });
    // Uncited context included; overlapping pages and repeats appear once; equal times keep their received order.
    expect(result.input.evidence.map((value) => value.id)).toEqual([
      "log-api-0001", "log-gateway-0001", "http-0002", "log-api-0002", "log-api-0003", "log-api-0004", "http-0005", "log-api-0005", "http-0009", "http-0010",
    ]);
    expect(result.input.untimedEvidence).toEqual([record["log-api-0006"]]);
    expect(result.input.evidence.find((value) => value.id === "http-0009")).toEqual(record["http-0009"]);

    // Provenance stays in the saved evidence check, the report frozen with the run, outside the model payload.
    expect(result.evidenceCheck).toEqual(original.evidenceReport);
    expect(result.evidenceCheck.retrievedEvidence.filter((value) => value.id === "http-0005").map((value) => value.callId)).toEqual(["call-1", "call-2"]);
    const payload = JSON.stringify(result.input);
    for (const hidden of ["call-1", "event-", "requestEventId", "PRIVATE", "CONTROLLER_ONLY", "Eve stopped"]) expect(payload).not.toContain(hidden);

    expect(await runs.getDaily(id)).toEqual(original);
  });

  it("reopens a saved attempt from a fresh process without creating another", async () => {
    const id = await dailyRun(investigation());
    const saved = await reviewSavedRun(pool, id, configure, respond());
    const json = await cli("packages/lab/src/cli.ts", ["review", saved.id, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(saved);
    const text = await cli("packages/lab/src/cli.ts", ["review", saved.id]);
    expect(text.code).toBe(0);
    for (const line of [
      `Review: ${saved.id}`,
      `Source: recorded Daily capture ${CLEAN_CAPTURE_ID} (evidence.jsonl ${grant.sha256["evidence.jsonl"]})`,
      "Input: 11 record(s): 4 HTTP observation(s), 6 timed and 1 untimed log line(s);",
      "Evidence checks (daily-evidence-v1), frozen when the investigation finished",
      "PASS citations: All 3 cited ID(s)",
      "Answer support review. Coverage of evidence not retrieved is not assessed.",
      "Claims: 3 supported, 0 unsupported, 0 uncertain.",
      'SUPPORTED [diagnosis] "/feed returned 500 errors"',
      "  Evidence: http-0005",
      "Review usage: 900 input, 300 output tokens; reported cost $0.001000",
    ]) expect(text.stdout).toContain(line);
    expect(await attempts(id)).toBe(1);
  }, 30_000);

  it("keeps repeated reviews as separate attempts that cannot be overwritten", async () => {
    const id = await dailyRun(investigation());
    const original = await runs.getDaily(id);
    const first = await reviewSavedRun(pool, id, configure, respond());
    const second = await reviewSavedRun(pool, id, configure, respond());
    expect(first.id).not.toBe(second.id);
    expect(await runs.getDaily(id)).toEqual(original);
    const store = createReviewStore(pool);
    await expect(store.finish(first.id, { status: "failed", error: "Overwrite." })).rejects.toThrow(/finished/);
    for (const change of ["input = '{}'", "evidence_check = '{}'", "configuration = '{}'", "review = NULL, status = 'failed', error = 'x'", "observation = '{}'"])
      await expect(pool.query(`UPDATE lab_investigation_reviews SET ${change} WHERE id = $1`, [first.id])).rejects.toThrow(/immutable|once/);
    expect(await store.get(first.id)).toEqual(first);
  });

  it("keeps a failed citation check beside a favorable review, and rejects a reviewer citing the investigator's invented ID", async () => {
    const id = await dailyRun(investigation(), { answer: { ...answer, evidenceIds: [...answer.evidenceIds, "http-0099"] } });
    const favorable = await reviewSavedRun(pool, id, configure, respond());
    expect(favorable.status).toBe("completed");
    expect(favorable.review?.claims[0].verdict).toBe("supported");
    expect(favorable.evidenceCheck.checks.citations).toMatchObject({ status: "fail", reason: expect.stringContaining("http-0099") });

    const invented = await reviewSavedRun(pool, id, configure, respond({
      ...assessment, claims: [{ ...assessment.claims[0], evidenceIds: ["http-0099"] }, ...assessment.claims.slice(1)],
    }));
    expect(invented).toMatchObject({ status: "failed", review: null, observation, error: expect.stringContaining("evidence-reference validation") });
  });

  it("reviews an answer with no evidence when its trace is valid", async () => {
    const id = await dailyRun([reasoning(), ...failedCall("call-1")], {
      answer: { diagnosis: "The cause is undetermined; no records were retrieved.", evidenceIds: [], uncertainty: "The tool call failed, so nothing is established." },
    });
    let supplied: unknown;
    const result = await reviewSavedRun(pool, id, configure, async (input, request) => {
      supplied = input;
      return respond({
        claims: [
          { field: "diagnosis", quote: "no records were retrieved", verdict: "supported", evidenceIds: [], explanation: "No records were supplied." },
          { field: "uncertainty", quote: "nothing is established", verdict: "supported", evidenceIds: [], explanation: "No records were supplied." },
        ],
        missingEvidence: ["Any record of the period."], summary: "The answer correctly claims nothing.",
      })(input, request);
    });
    expect(result.status).toBe("completed");
    expect(supplied).toMatchObject({ evidence: [], untimedEvidence: [] });
    expect(JSON.stringify(supplied)).not.toContain("PRIVATE TOOL FAILURE");
    expect(result.evidenceCheck.checks).toMatchObject({ toolTrace: { status: "pass" }, retrieval: { status: "fail" }, citations: { status: "not_evaluated" } });
  });

  it("resolves latest to one run and configures the review for its source", async () => {
    const id = await dailyRun(investigation());
    const sources: ReviewSource[] = [];
    const result = await reviewSavedRun(pool, "latest", (source) => (sources.push(source), configs[source]), respond());
    expect(sources).toEqual(["daily_capture"]);
    expect(result).toMatchObject({ runId: id, source: "daily_capture", configuration: { promptVersion: "test-daily-v1" } });
  });
});

describe("refused before an attempt or a model request", () => {
  const conflicting = () => [
    ...call("call-1", "get_daily_logs", { messageContains: "admin" }, pick("log-api-0003")),
    ...call("call-2", "get_daily_logs", { messageContains: "admin" }, [{ ...shutdown, message: "AdminShutdown, rewritten" }]),
  ];
  const otherCapture = () => call("call-1", "get_daily_logs", {}, pick("log-api-0003"), { captureId: "20261022T050320Z-ad558c" });
  const oversized = () => call("call-1", "get_daily_logs", {}, [{ ...shutdown, message: `psycopg ${"x".repeat(66_000)}` }]);

  it.each([
    ["an unfinished investigation", () => dailyRun(investigation(), { finish: null }), /requires a completed investigation/],
    ["a failed investigation", () => dailyRun(investigation(), { finish: "failed" }), /requires a completed investigation/],
    ["records with conflicting contents", () => dailyRun(conflicting(), { answer: { ...answer, evidenceIds: [] } }), /invalid evidence trace/],
    ["records from another capture", () => dailyRun(otherCapture(), { answer: { ...answer, evidenceIds: [] } }), /invalid evidence trace/],
    ["input over 64 KiB", () => dailyRun(oversized(), { answer: { ...answer, evidenceIds: [] } }), /over the 65536-byte limit\. No review was created and no model request was made/],
  ])("%s", async (_name, create, message) => {
    const id = await create();
    let called = false;
    await expect(reviewSavedRun(pool, id, configure, async () => { called = true; return assessment; })).rejects.toThrow(message);
    expect(called).toBe(false);
    expect(await attempts(id)).toBe(0);
  });

  it("a run whose saved events changed after it was sealed", async () => {
    const id = await dailyRun(investigation());
    const [{ eventId }] = (await pool.query<{ eventId: string }>(
      `SELECT event_id AS "eventId" FROM lab_investigation_events WHERE run_id = $1 AND payload ->> 'type' = 'action.result' ORDER BY sequence LIMIT 1`, [id])).rows;
    const remove = () => pool.query("DELETE FROM lab_investigation_events WHERE run_id = $1 AND event_id = $2", [id, eventId]);
    await expect(remove()).rejects.toThrow(/deleted only with their whole run/);
    // Only bypassing the triggers removes it, and the fingerprint then no longer matches.
    await bypassingTriggers(pool, "lab_investigation_events", remove);
    expect((await runs.getDaily(id)).integrity).toMatchObject({ status: "mismatch", currentEventCount: investigation().length });
    let called = false;
    await expect(reviewSavedRun(pool, id, configure, async () => { called = true; return assessment; })).rejects.toThrow(/no longer matches its integrity fingerprint/);
    expect(called).toBe(false);
    expect(await attempts(id)).toBe(0);
  });

  it("a frozen evidence report the saved events no longer produce", async () => {
    const id = await dailyRun(investigation());
    // The report is derived from the events and outside the fingerprint, so this
    // leaves integrity verified; recomputing the report from the events catches it.
    await bypassingTriggers(pool, "lab_investigation_runs", () => pool.query(
      `UPDATE lab_investigation_runs SET evidence_report = jsonb_set(evidence_report, '{citedEvidenceIds}', '[]') WHERE id = $1`, [id]));
    expect((await runs.getDaily(id)).integrity.status).toBe("verified");
    let called = false;
    await expect(reviewSavedRun(pool, id, configure, async () => { called = true; return assessment; })).rejects.toThrow(/no longer produce the evidence report frozen/);
    expect(called).toBe(false);
    expect(await attempts(id)).toBe(0);
  });

  it("a configuration for another source", async () => {
    const id = await dailyRun(investigation());
    await expect(reviewSavedRun(pool, id, () => configs.simulated, async () => assessment)).rejects.toThrow(/is for simulated runs/);
    expect(await attempts(id)).toBe(0);
  });
});

describe("failed Daily attempts stay saved and explicit", () => {
  it.each([
    ["provider failure", async () => { throw Object.assign(new Error("SECRET provider body"), { statusCode: 503 }); }, "failed", /HTTP 503/, null],
    ["timeout", async () => { throw Object.assign(new Error("SECRET"), { name: "TimeoutError" }); }, "failed", /time limit/, null],
    ["a fabricated quotation", respond({ ...assessment, claims: [{ ...assessment.claims[0], quote: "Every recorded /feed request succeeded." }, ...assessment.claims.slice(1)] }), "failed", /validation/, observation],
  ] as const)("%s", async (_name, generate, status, error, retained) => {
    const id = await dailyRun(investigation());
    const result = await reviewSavedRun(pool, id, configure, generate);
    expect(result).toMatchObject({ status, review: null, observation: retained, error: expect.stringMatching(error) });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("cancellation keeps the reported usage and no assessment", async () => {
    const id = await dailyRun(investigation());
    const controller = new AbortController();
    const result = await reviewSavedRun(pool, id, configure, async (input, request) => {
      const review = await respond()(input, request);
      controller.abort();
      return review;
    }, { signal: controller.signal });
    expect(result).toMatchObject({ status: "cancelled", review: null, observation, error: "Review cancelled." });
  });

  it("a final status that cannot be saved is reported, not hidden", async () => {
    const id = await dailyRun(investigation());
    let reviewId = "";
    // Another writer settles the attempt first, as worker recovery would.
    const run = reviewSavedRun(pool, id, configure, async (input, request) => {
      await pool.query("UPDATE lab_investigation_reviews SET status = 'failed', error = 'Recovered elsewhere.', finished_at = clock_timestamp() WHERE run_id = $1", [id]);
      return respond()(input, request);
    }, { onCreated: (attempt) => { reviewId = attempt.id; } });
    await expect(run).rejects.toThrow(`Could not save the final status of review ${reviewId}`);
    expect(await createReviewStore(pool).get(reviewId)).toMatchObject({ status: "failed", error: "Recovered elsewhere.", review: null, observation: null });
  });

  it("missing credentials from the CLI save a failed attempt with the Daily configuration and model override", async () => {
    const id = await dailyRun(investigation());
    const result = await cli("scripts/lab-review.ts", [id], {
      LAB_REVIEW_GATEWAY_API_KEY: "", AI_GATEWAY_API_KEY: "", VERCEL_OIDC_TOKEN: "", LAB_REVIEW_MODEL: "test/override-model",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`Reviewing recorded Daily run ${id}: 11 retrieved record(s)`);
    expect(result.stdout).toContain("One request to test/override-model with prompt daily-review-v1; no tools, no retries, 60-second limit.");
    expect(result.stderr).toContain("AI_GATEWAY_API_KEY");
    const reviewId = result.stdout.match(/^Review: (.+)$/m)?.[1];
    const saved = await createReviewStore(pool).get(reviewId!);
    expect(saved).toMatchObject({
      runId: id, source: "daily_capture", status: "failed", review: null, observation: null,
      configuration: { source: "daily_capture", modelId: "test/override-model", promptVersion: "daily-review-v1", settings: { maxInputBytes: 65_536, maxOutputTokens: 4096, timeoutMs: 60_000, maxRetries: 0 } },
    });
  }, 30_000);
});

it("a completed Daily run stays out of the simulated-only workbench routes", async () => {
  const id = await dailyRun(investigation());
  const { trialId } = await createTrial(pool);
  const simulated = await runs.create({ trialId, deploymentId: "B", task: "Investigate B.", instructions: "Simulated.", agentConfigSource: "{}" });
  await expect(createWebStore(pool).get(id)).rejects.toThrow(UnsupportedRunSourceError);
  const listed = (await createWebStore(pool).list()).items.map((item) => item.id);
  expect(listed).toContain(simulated);
  expect(listed).not.toContain(id);
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  try {
    const submitted = jobs.submit({ requestId: randomUUID(), kind: "review", runId: id });
    await expect(submitted).rejects.toThrow(JobError);
    await expect(submitted).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("recorded Daily capture") });
  } finally {
    await jobs.unregister(owner);
  }
});

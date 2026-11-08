import { expect, test, type Page } from "@playwright/test";
import type { ReviewConfig } from "@agent-lab/contracts";
import type { DailyCaptureEvidence } from "@agent-lab/contracts/daily-capture";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createCoverageStore } from "@agent-lab/lab/daily-coverage";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { createJobStore } from "@agent-lab/lab/jobs";
import { migrate } from "@agent-lab/lab/migrate";
import { reviewSavedRun } from "@agent-lab/lab/reviews";
import { createRunStore } from "@agent-lab/lab/runs";
import { bypassingTriggers } from "../../packages/lab/test/administrator";
import { capturesDir, feedAvailabilityEvidence, log, observation, removeCaptureDirs, writeCapture } from "../../packages/lab/test/daily-capture-fixture";

// Daily investigations in the browser, from labeled fixtures saved in the test
// database. Every answer and review here says "Fixture"; none is a model
// result. Launch requests are intercepted, so no job or model call starts.

const CAPTURE_ID = "20261031T150000Z-e2e001";
const pool = createPool();
const runs = createRunStore(pool);
const created: string[] = [];
const trials: string[] = [];
let assessedId: string, uncheckedId: string, retryId: string, brokenId: string, simulatedId: string;

const longBody = { status: "ok", detail: "Fixture body line that is deliberately long. ".repeat(120), items: Array.from({ length: 60 }, (_, index) => ({ index, label: `fixture-item-${index}` })) };
const evidence: DailyCaptureEvidence[] = [
  ...feedAvailabilityEvidence(),
  observation(13, 200, { path: "/healthz", body: longBody }),
  ...Array.from({ length: 30 }, (_, index) => log(10 + index, `INFO fixture heartbeat ${index + 1} ${"padding ".repeat(index === 25 ? 60 : 1)}`)),
];
const byId = Object.fromEntries(evidence.map((record) => [record.id, record]));
const pick = (...ids: string[]) => ids.map((id) => byId[id]);
const answer = {
  diagnosis: "Fixture: /feed returned HTTP 500 and timed out while the API logged pool timeouts.",
  evidenceIds: ["http-0002", "http-0003", "log-api-0035"],
  uncertainty: "Fixture: the recording does not say why the database became unavailable.",
};
const reviewer: ReviewConfig = {
  source: "daily_capture", modelId: "fixture/reviewer", promptVersion: "fixture-daily-v1", schemaVersion: 1, system: "Fixture.",
  settings: { maxOutputTokens: 100, maxRetries: 0, timeoutMs: 1_000, maxInputBytes: 200_000 },
};

test.beforeAll(async () => {
  await migrate(pool);
  const dir = await capturesDir();
  await writeCapture(dir, { captureId: CAPTURE_ID, evidence });
  const access = createCaptureAccess(pool, dir);
  const logs = evidence.filter((record) => record.kind === "log");
  async function investigation(withReview = false) {
    const { grant } = await access.grant(CAPTURE_ID);
    const id = await runs.createDaily({
      captureId: CAPTURE_ID, grantId: grant.id, sha256: grant.sha256,
      task: "Fixture task: investigate Daily's feed API during the recorded period.", instructions: "PRIVATE_FIXTURE_INSTRUCTIONS",
      agentConfigSource: "PRIVATE_FIXTURE_CONFIG", configuration: { toolMode: "daily_capture" },
    });
    created.push(id);
    const source = { captureId: CAPTURE_ID, evidenceSha256: grant.sha256["evidence.jsonl"] };
    const turn = { turnId: "turn_0", sequence: 0 };
    let index = 0;
    const append = (type: string, data: object) => runs.appendEvent(id, { type, meta: { id: `${id}-${index++}`, at: new Date(Date.UTC(2026, 9, 31, 15, 10, index)).toISOString() }, data: { ...turn, ...data } });
    const call = async (callId: string, toolName: string, input: object, records: DailyCaptureEvidence[], extra: object = {}) => {
      await append("step.started", { stepIndex: index, modelId: "fixture/investigator" });
      await append("actions.requested", { actions: [{ kind: "tool-call", toolName, callId, input }] });
      await append("action.result", { status: "completed", result: { kind: "tool-result", toolName, callId,
        output: { ...source, [toolName === "get_daily_logs" ? "logs" : "observations"]: records, oversized: [], nextCursor: null, ...extra } } });
    };
    await call("call-1", "get_daily_http_observations", { path: "/feed", limit: 4 }, pick("http-0001", "http-0002", "http-0003", "http-0004"), { nextCursor: "page-2" });
    await call("call-2", "get_daily_logs", {}, logs);
    await call("call-3", "get_daily_http_observations", { path: "/healthz" }, pick("http-0013"));
    await append("result.completed", { result: answer });
    await runs.finish(id, { status: "completed", answer, message: "PRIVATE_FIXTURE_MESSAGE" });
    if (withReview)
      await reviewSavedRun(pool, id, () => reviewer, async (_input, { onResponse }) => {
        await onResponse({ responseId: null, resolvedModelId: "fixture/reviewer", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, costUsd: null } });
        return {
          summary: "Fixture review: the recorded 500 and timeout support the symptom claims.",
          missingEvidence: ["Fixture: database logs."],
          claims: [
            { field: "diagnosis", quote: "returned HTTP 500 and timed out", verdict: "supported", explanation: "Fixture explanation.", evidenceIds: ["http-0002", "http-0003"] },
            { field: "uncertainty", quote: answer.uncertainty, verdict: "supported", explanation: "Fixture explanation.", evidenceIds: [] },
          ],
        };
      });
    return id;
  }
  assessedId = await investigation(true);
  await createCoverageStore(pool).assess(assessedId, { capturesDir: dir });
  uncheckedId = await investigation();
  retryId = await investigation();
  brokenId = await investigation();
  await createCoverageStore(pool).assess(brokenId, { capturesDir: dir });
  await bypassingTriggers(pool, "lab_investigation_runs", () =>
    pool.query("UPDATE lab_investigation_runs SET answer = jsonb_set(answer, '{uncertainty}', '\"Fixture: edited after sealing.\"') WHERE id = $1", [brokenId]));
  // A failed coverage job, as a worker would leave it.
  const jobs = createJobStore(pool, { capturesDir: dir });
  const owner = crypto.randomUUID();
  await jobs.register(owner);
  try {
    const job = await jobs.submit({ requestId: crypto.randomUUID(), kind: "coverage", runId: retryId });
    await jobs.claim(owner);
    await jobs.finish(job.id, "failed", "Coverage could not be checked. Fixture failure: the recording was moved.");
  } finally {
    await jobs.unregister(owner);
  }
  const trial = await createTrial(pool);
  trials.push(trial.trialId);
  simulatedId = await runs.create({ trialId: trial.trialId, deploymentId: "B", task: "Fixture: investigate B", instructions: "", agentConfigSource: "" });
  await runs.finish(simulatedId, { status: "cancelled", error: "Fixture." });
  await removeCaptureDirs();
});
test.afterAll(async () => {
  await pool.query("DELETE FROM lab_investigation_runs WHERE id = ANY($1::uuid[])", [created]);
  await deleteTrials(pool, trials);
  await pool.end();
});

const shot = (page: Page, name: string) => page.screenshot({ path: `.context/ui/${name}.png`, fullPage: true });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("lists both sources, filters by source, and keeps deployment links working", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/runs");
  const daily = page.getByRole("row").filter({ has: page.getByRole("link", { name: `Open investigation ${assessedId}` }) });
  await expect(daily).toContainText("Daily recording · Oct 31, 2026, 15:00:00 UTC");
  await expect(daily).toContainText(CAPTURE_ID);
  await expect(daily).toContainText("Coverage missed: Recovery");
  await expect(daily).toContainText("Reviewed");
  await expect(page.getByRole("row").filter({ has: page.getByRole("link", { name: `Open investigation ${retryId}` }) })).toContainText("Coverage check failed");
  await shot(page, "list-all");
  await page.getByRole("combobox", { name: "Filter source" }).click();
  await page.getByRole("option", { name: "Daily recordings", exact: true }).click();
  await expect(page).toHaveURL(/source=daily_capture/);
  await expect(page.getByRole("combobox", { name: "Filter deployment" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Open investigation ${simulatedId}` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Open investigation ${assessedId}` })).toBeVisible();
  await page.goto("/runs?source=simulated");
  await expect(page.getByRole("link", { name: `Open investigation ${assessedId}` })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Open investigation ${simulatedId}` })).toBeVisible();
  await page.goto("/runs?deployment=B&status=cancelled");
  await expect(page.getByRole("link", { name: `Open investigation ${simulatedId}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Open investigation ${assessedId}` })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("PRIVATE_");
});

test("shows the source, answer, checks, coverage rows, and review in order, with records the investigator never received labeled", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${assessedId}`);
  await expect(page.getByRole("heading", { name: "Daily recording", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-heading")).toContainText(CAPTURE_ID);
  await expect(page.locator(".workspace-heading")).toContainText("Recorded sandbox incident");
  const sections = await page.locator(".workspace-results-content > section").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
  expect(sections).toEqual(["Investigation task", "Investigator answer", "Evidence checks", "Evidence coverage", "Independent review"]);
  await expect(page.getByRole("region", { name: "Evidence checks" })).toContainText("6 / 6 passed");
  const coverage = page.getByRole("region", { name: "Evidence coverage" });
  await expect(coverage.locator(".coverage-row")).toHaveCount(3);
  await expect(coverage.getByRole("button", { name: "Server errors: covered" })).toBeVisible();
  await expect(coverage.locator(".coverage-row").nth(1)).toContainText("No response");
  await expect(coverage.locator(".coverage-row").nth(1)).toContainText("Covered");
  const recovery = coverage.locator(".coverage-row").nth(2);
  await expect(recovery).toContainText("Recovery");
  await expect(recovery).toContainText("Missed");
  await expect(recovery).toContainText("In recording; not retrieved");
  await expect(coverage).not.toContainText(/correct/i);
  await shot(page, "daily-run");
  await recovery.getByRole("button", { name: "http-0009 · in recording; not retrieved" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "In recording; not retrieved" })).toBeVisible();
  await expect(sheet).toContainText("never received it");
  await expect(sheet).not.toContainText("Returned by");
  await expect(sheet).toContainText("HTTP 200");
  await shot(page, "not-retrieved-sheet");
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  // Received evidence never includes it.
  // The drawer button is for narrow screens; on desktop, open it the same way.
  await page.locator(".mobile-evidence-button").dispatchEvent("click");
  await expect(page.getByRole("dialog")).toContainText("Received evidence");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Inspect http-0009" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const review = page.getByRole("region", { name: "Independent review" });
  await expect(review).toContainText("Fixture review: the recorded 500 and timeout support the symptom claims.");
  expect(await page.locator("body").innerText()).not.toContain("PRIVATE_");
});

test("follows a citation to the exact received record, even past Show more, and opens it in full", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${assessedId}`);
  const panel = page.getByRole("complementary", { name: "Investigation activity" });
  await expect(panel.getByRole("region", { name: "Investigator steps" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Automated checks" })).toContainText("Evidence checks completed");
  await expect(panel.getByRole("region", { name: "Automated checks" })).toContainText("Coverage saved: missed");
  await expect(panel.getByRole("region", { name: "Review activity" })).toContainText("Review completed");
  await expect(panel.getByRole("button", { name: "get_daily_http_observations: 4 HTTP observations · more pages available" })).toBeVisible();
  await expect(panel.getByText("Requested · path /feed · first page · up to 4")).toBeVisible();
  await page.locator(".workspace-answer").getByRole("button", { name: "log-api-0035", exact: true }).click();
  await expect(page).toHaveURL(/log=log-api-0035/);
  const selected = panel.locator(".evidence-log[data-selected=true]");
  await expect(selected).toContainText("INFO fixture heartbeat 26");
  await expect(selected).toBeFocused();
  // The record is past the first 20 of 33 lines, yet visible; the rest stay behind Show more.
  await expect(panel.getByRole("button", { name: /Show \d+ more of \d+/ })).toBeVisible();
  await shot(page, "citation-selected");
  await selected.getByRole("button", { name: "Open full record" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Received evidence" })).toBeVisible();
  await expect(sheet.locator(".evidence-log[data-selected=true]")).toContainText("Returned by");
  await expect(sheet.locator(".evidence-log[data-selected=true]")).toContainText("call-2");
  await expect(sheet.getByText("Raw JSON")).toBeVisible();
  await page.keyboard.press("Escape");
  // HTTP observations: method, path, outcome, and duration; the long body stays in the Sheet.
  await panel.getByRole("button", { name: "get_daily_http_observations: 1 HTTP observation · last page" }).click();
  const healthz = panel.locator(".evidence-log").filter({ hasText: "GET /healthz" });
  await expect(healthz).toContainText("HTTP 200");
  await healthz.getByRole("button", { name: "Inspect http-0013" }).click();
  await healthz.getByRole("button", { name: "Open full record" }).click();
  const body = page.getByRole("dialog").locator("[data-slot=code-block]").filter({ hasText: "Response body" });
  await expect(body).toBeVisible();
  await expect(body).toContainText("fixture-item-59");
  await shot(page, "http-record-sheet");
  expect(await noOverflow(page)).toBe(true);
  await page.getByRole("dialog").getByRole("button", { name: "Wrap response body lines" }).click();
  const pre = body.locator("pre");
  expect(await pre.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("offers Check coverage and Retry coverage only as explicit requests", async ({ page }) => {
  const posted: unknown[] = [];
  await page.route("**/api/jobs", (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: { message: "Test interception: no job was created." } } });
  });
  await page.goto(`/runs/${uncheckedId}`);
  const coverage = page.getByRole("region", { name: "Evidence coverage" });
  await expect(coverage).toContainText("No coverage assessment is saved");
  await expect(coverage.locator(".coverage-row")).toHaveCount(3);
  // Opening and reloading the page only reads saved state.
  await page.reload();
  expect(posted).toEqual([]);
  // The request is intercepted before admission, so no job is created.
  const jobs = createJobStore(pool);
  const owner = crypto.randomUUID();
  await jobs.register(owner);
  try {
    await page.reload();
    await coverage.getByRole("button", { name: "Check coverage" }).click();
    await expect.poll(() => posted).toEqual([{ requestId: expect.any(String), kind: "coverage", runId: uncheckedId }]);
    await expect(page.getByRole("alert").filter({ hasText: "Test interception" })).toBeVisible();
    await page.goto(`/runs/${retryId}`);
    const retry = page.getByRole("region", { name: "Evidence coverage" });
    await expect(retry).toContainText("Coverage could not be checked");
    await expect(retry).toContainText("Fixture failure: the recording was moved.");
    await expect(page.getByRole("region", { name: "Automated checks" })).toContainText("Coverage check failed");
    await shot(page, "retry-coverage");
    await retry.getByRole("button", { name: "Retry coverage" }).click();
    await expect.poll(() => posted.length).toBe(2);
    expect(posted[1]).toEqual({ requestId: expect.any(String), kind: "coverage", runId: retryId });
  } finally {
    await jobs.unregister(owner);
  }
});

test("shows an integrity mismatch prominently, disables new assessments, and marks saved ones historical", async ({ page }) => {
  await page.goto(`/runs/${brokenId}`);
  await expect(page.getByRole("alert").filter({ hasText: "no longer matches its integrity fingerprint" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Evidence checks" })).toContainText("Failed");
  await expect(page.getByRole("region", { name: "Evidence coverage" })).toContainText("Saved for an earlier state of this record");
  await expect(page.getByRole("complementary", { name: "Investigation activity" }).getByRole("button", { name: "Review answer" })).toBeDisabled();
  await shot(page, "integrity-mismatch");
});

test("keeps the review action reachable with the panel closed and on a phone, without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/runs/${assessedId}`);
  await page.getByRole("button", { name: "Close activity" }).click();
  await expect(page.getByRole("region", { name: "Independent review" }).getByRole("button", { name: "Review answer" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/runs/${assessedId}`);
  await expect(page.getByRole("button", { name: "Review answer" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Independent review" }).getByRole("button", { name: "Review answer" })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.locator(".workspace-answer").getByRole("button", { name: "http-0002", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("GET /feed");
  await page.keyboard.press("Escape");
  await shot(page, "phone");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/runs/${assessedId}`);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await shot(page, "dark");
});

test("launches a Daily recording by default and explains empty, invalid, offline, and busy states", async ({ page }) => {
  let runner = { enabled: true, online: true, busy: false, activeJob: null as null | object };
  let captures: unknown[] = [
    { captureId: "20261022T050138Z-39b307", available: true, recordedAt: "2026-10-22T05:01:38.079Z", finishedAt: "2026-10-22T05:02:52.740Z", httpObservations: 28, logLines: 821 },
    { captureId: "20261022T045819Z-89a170", available: true, recordedAt: "2026-10-22T04:58:19.103Z", finishedAt: "2026-10-22T04:59:30.168Z", httpObservations: 30, logLines: 956 },
    { captureId: "20261022T050320Z-ad558c", available: false, recordedAt: "2026-10-22T05:03:20.000Z", problem: { code: "rejected", message: "Capture 20261022T050320Z-ad558c is cancelled; only a completed recording is served as evidence." } },
  ];
  const posted: unknown[] = [];
  await page.route("**/api/runner", (route) => route.fulfill({ json: runner }));
  await page.route("**/api/captures", (route) => route.fulfill({ json: { captures } }));
  await page.route("**/api/jobs", (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: { message: "Test interception: no job was created." } } });
  });
  await page.goto("/runs");
  await page.getByRole("button", { name: "New investigation" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("combobox", { name: "Source" })).toContainText("Daily recording");
  await expect(sheet).toContainText("does not stop a database");
  await expect(sheet.getByRole("combobox", { name: "Recording" })).toContainText("Oct 22, 2026, 05:01:38 UTC");
  await expect(sheet).toContainText("28 HTTP observations, 821 log lines");
  await expect(sheet).toContainText("20261022T050138Z-39b307");
  await sheet.getByRole("combobox", { name: "Recording" }).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option").filter({ hasText: "04:58:19" })).toContainText("30 HTTP observations · 956 log lines · 20261022T045819Z-89a170");
  await page.getByRole("option", { name: /04:58:19/ }).click();
  await sheet.getByText("1 recording can't be investigated").click();
  await expect(sheet).toContainText("is cancelled; only a completed recording is served as evidence.");
  await shot(page, "launch-daily");
  await sheet.getByRole("button", { name: "Run investigation", exact: true }).click();
  await expect.poll(() => posted).toEqual([{ requestId: expect.any(String), kind: "investigate", source: "daily_capture", captureId: "20261022T045819Z-89a170" }]);
  await expect(sheet.getByRole("alert").filter({ hasText: "Test interception" })).toBeVisible();
  // A retry of the same choice reuses its request ID, so it cannot start twice.
  await sheet.getByRole("button", { name: "Run investigation", exact: true }).click();
  await expect.poll(() => posted.length).toBe(2);
  expect((posted[1] as { requestId: string }).requestId).toBe((posted[0] as { requestId: string }).requestId);
  await page.keyboard.press("Escape");

  runner = { ...runner, busy: true, activeJob: { id: crypto.randomUUID(), kind: "investigate", status: "running", runId: null, reviewId: null, error: null, cancelRequested: false } };
  await page.getByRole("button", { name: "New investigation" }).click();
  await expect(sheet).toContainText("Worker busy with another operation");
  await expect(sheet.getByRole("link", { name: "View active operation" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Run investigation", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  runner = { enabled: true, online: false, busy: false, activeJob: null };
  captures = [];
  await page.getByRole("button", { name: "New investigation" }).click();
  await expect(sheet).toContainText("No saved recordings yet");
  await expect(sheet).toContainText("pnpm daily:capture");
  await expect(sheet).toContainText("Worker offline");
  await shot(page, "launch-empty");
  await sheet.getByRole("button", { name: "Use a simulated case" }).click();
  await expect(sheet.getByRole("combobox", { name: "Case", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Run investigation", exact: true })).toBeDisabled();
  expect(posted).toHaveLength(2);
});

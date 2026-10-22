import { expect, test } from "@playwright/test";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { getCase } from "@agent-lab/lab/cases";
import { createRunStore } from "@agent-lab/lab/runs";
import { migrate } from "@agent-lab/lab/migrate";
const pool = createPool(), trials: string[] = [];
let runId: string, decisiveId: string;
test.beforeAll(async () => {
  await migrate(pool);
  const trial = await createTrial(pool, getCase("missing-config")); trials.push(trial.trialId);
  const runs = createRunStore(pool);
  runId = await runs.create({ trialId: trial.trialId, deploymentId: "B", task: "Investigate B.", instructions: "Read logs.", agentConfigSource: "test", caseSnapshot: trial.caseSnapshot });
  decisiveId = trial.caseSnapshot!.decisiveEvidenceIds[0];
  const answer = { diagnosis: "The disk is full.", uncertainty: "No disk measurements available.", evidenceIds: [decisiveId], outcome: { state: "failed" as const, cause: "other" as const, configurationKey: null } };
  for (const [index, event] of [
    { type: "actions.requested", data: { actions: [{ kind: "tool-call", toolName: "get_logs", callId: "case-call", input: { deploymentId: "B" } }] } },
    { type: "action.result", data: { status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "case-call", output: { logs: trial.caseSnapshot!.logs } } } },
    { type: "result.completed", data: { result: answer } },
  ].entries()) await runs.appendEvent(runId, { ...event, data: { ...event.data, turnId: "turn" }, meta: { id: `case-${index}`, at: new Date().toISOString() } });
  await runs.finish(runId, { status: "completed", answer, message: "" });
});
test.afterAll(async () => { await deleteTrials(pool, trials); await pool.end(); });
test("shows outcome failure separately from valid evidence and preserves it through citation navigation and refresh", async ({ page }) => {
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST") posts++; });
  await page.goto(`/runs/${runId}`);
  const outcome = page.getByRole("region", { name: "Outcome checks" });
  await expect(outcome).toContainText("Failed");
  await expect(outcome).toContainText("missing_configuration");
  await expect(outcome).toContainText("other");
  await expect(page.getByRole("region", { name: "Evidence checks" })).toContainText("5 / 5 passed");
  await outcome.getByRole("button", { name: decisiveId, exact: true }).click();
  await expect(page.locator(".evidence-log[data-selected=true]")).toContainText("DATABASE_URL is missing");
  await page.reload();
  await expect(outcome).toContainText("Failed");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/runs");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: `Open investigation ${runId}` }) });
  await expect(row).toContainText("Missing configuration");
  await expect(row).toContainText("Outcome failed");
  expect(posts).toBe(0);
});
test("selects one named case and sends only that selector on explicit launch", async ({ page }) => {
  let submitted: unknown;
  await page.route("**/api/runner", (route) => route.fulfill({ json: { enabled: true, online: true, busy: false, activeJob: null } }));
  await page.route("**/api/jobs", (route) => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: "Test submission intercepted; no model work." } }); });
  await page.goto("/runs");
  await page.getByRole("button", { name: "New investigation" }).click();
  await page.getByRole("combobox", { name: "Case", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.getByRole("option", { name: "Recovered startup", exact: true }).click();
  await page.getByRole("button", { name: "Run investigation", exact: true }).click();
  await expect.poll(() => submitted).toEqual({ requestId: expect.any(String), kind: "investigate", caseId: "recovered-startup" });
});

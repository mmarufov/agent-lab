import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool } from "../src/database";
import { createTrial, deleteTrials } from "../src/fixtures";
import { getCase } from "../src/cases";
import { createRunStore } from "../src/runs";
import { createWebStore } from "../src/web";
import { createLab } from "../src/service";
import { migrate } from "../src/migrate";
import { createReviewStore } from "../src/reviews";
const pool = createPool(), runs = createRunStore(pool), trials: string[] = [];
beforeAll(() => migrate(pool));
afterAll(async () => { await deleteTrials(pool, trials); await pool.end(); });
async function fixture() {
  const definition = getCase("recovered-startup");
  const trial = await createTrial(pool, definition);
  trials.push(trial.trialId);
  const id = await runs.create({ trialId: trial.trialId, deploymentId: "B", task: "Investigate B.", instructions: "Read logs.", agentConfigSource: "test", caseSnapshot: trial.caseSnapshot });
  return { trial, id, definition };
}
async function complete(id: string, snapshot: NonNullable<Awaited<ReturnType<typeof createTrial>>["caseSnapshot"]>) {
  const answer = { diagnosis: "Earlier configuration failure recovered.", uncertainty: "Long-term health is unknown.", evidenceIds: snapshot.decisiveEvidenceIds,
    outcome: { state: "recovered" as const, cause: "missing_configuration" as const, configurationKey: "DATABASE_URL" } };
  for (const [index, event] of [
    { type: "actions.requested", data: { actions: [{ kind: "tool-call", toolName: "get_logs", callId: "call", input: { deploymentId: "B" } }] } },
    { type: "action.result", data: { status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "call", output: { logs: snapshot.logs } } } },
    { type: "result.completed", data: { result: answer } },
  ].entries()) await runs.appendEvent(id, { ...event, meta: { id: `event-${index}`, at: new Date().toISOString() }, data: { ...event.data, turnId: "turn" } });
  await runs.finish(id, { status: "completed", answer, message: "" });
}
it("seeds fresh ordered case evidence and atomically reopens the saved answer and assessment", async () => {
  const { trial, id, definition } = await fixture();
  expect(trial.caseSnapshot).toBeTruthy();
  expect(await createLab(pool).getLogs(trial.trialId, "B")).toEqual(trial.caseSnapshot!.logs);
  await complete(id, trial.caseSnapshot!);
  definition.expected.state = "failed";
  definition.logs.length = 0;
  const saved = await runs.get(id);
  expect(saved).toMatchObject({ status: "completed", caseId: "recovered-startup", caseVersion: 1, resultSchemaVersion: 2, outcomeReport: { status: "pass", expected: { state: "recovered" } } });
  const web = await createWebStore(pool).get(id);
  expect(web.outcome).toEqual(saved.outcomeReport);
  expect(web.caseName).toBe("Recovered startup");
  expect((await createWebStore(pool).list()).items.find((run) => run.id === id)).toMatchObject({ caseName: "Recovered startup", outcomeStatus: "pass" });
  await expect(pool.query("UPDATE lab_investigation_runs SET case_snapshot = '{}' WHERE id = $1", [id])).rejects.toThrow(/immutable/i);
  await expect(pool.query("UPDATE lab_investigation_runs SET outcome_report = '{}' WHERE id = $1", [id])).rejects.toThrow(/immutable/i);
  // Editing live trial logs cannot silently recompute the saved assessment on refresh.
  await pool.query("DELETE FROM lab_deployment_logs WHERE trial_id = $1", [trial.trialId]);
  expect((await createWebStore(pool).get(id)).outcome).toEqual(saved.outcomeReport);
  const reviews = createReviewStore(pool);
  const review = await reviews.start(id, { modelId: "test/model", promptVersion: "test", schemaVersion: 1, system: "Assess prose.", settings: { maxOutputTokens: 1000, maxRetries: 0, timeoutMs: 1000, maxInputBytes: 65536 } });
  expect(Object.keys(review.input).sort()).toEqual(["answer", "deploymentId", "evidence", "task"]);
  expect(JSON.stringify(review.input)).not.toMatch(/recovered-startup|decisiveEvidenceIds|caseSnapshot|expected|outcomeReport/);
  await reviews.finish(review.id, { status: "cancelled", error: "Test cleanup." });
});
it("requires v2 for case completion and keeps cancellation unassessed", async () => {
  const { id } = await fixture();
  await expect(runs.finish(id, { status: "completed", answer: { diagnosis: "Legacy", evidenceIds: [], uncertainty: "Unknown" }, message: "" })).rejects.toThrow();
  expect(await runs.get(id)).toMatchObject({ status: "running", answer: null, outcomeReport: null });
  await runs.finish(id, { status: "cancelled", error: "Cancelled" });
  expect((await runs.get(id)).outcomeReport?.status).toBe("not_evaluated");
});
it("preserves deployment-only compatibility with no outcome pass", async () => {
  const trial = await createTrial(pool); trials.push(trial.trialId);
  const id = await runs.create({ trialId: trial.trialId, deploymentId: "B", task: "Legacy", instructions: "Legacy", agentConfigSource: "Legacy" });
  await runs.finish(id, { status: "completed", answer: { diagnosis: "Legacy", evidenceIds: [], uncertainty: "Unknown" }, message: "" });
  expect(await runs.get(id)).toMatchObject({ resultSchemaVersion: 1, caseSnapshot: null, outcomeReport: null });
  expect((await createWebStore(pool).get(id)).outcome.status).toBe("not_evaluated");
});

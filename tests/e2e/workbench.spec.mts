import { expect, test, webkit } from "@playwright/test";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { createRunStore } from "@agent-lab/lab/runs";
import { reviewSavedRun } from "@agent-lab/lab/reviews";
import { migrate } from "@agent-lab/lab/migrate";

const pool = createPool();
const trials: string[] = [];
let runId: string, failedId: string, cancelledId: string, emptyId: string;
let missingCitationId: string;
test.beforeAll(async () => {
  await migrate(pool);
  const trial = await createTrial(pool);
  trials.push(trial.trialId);
  const runs = createRunStore(pool);
  const input = {
    trialId: trial.trialId,
    deploymentId: "B",
    task: "UI test: investigate B",
    instructions: "PRIVATE_TEST_INSTRUCTIONS",
    agentConfigSource: "PRIVATE_TEST_CONFIGURATION",
  };
  runId = await runs.create(input);
  const answer = {
    diagnosis: "DATABASE_URL is missing.",
    evidenceIds: ["log-17"],
    uncertainty: "The cause of the configuration change is unknown.",
  };
  const events = [
    {
      type: "actions.requested",
      data: {
        turnId: "turn",
        actions: [
          {
            kind: "tool-call",
            toolName: "get_logs",
            callId: "browser-test-call",
            input: { deploymentId: "B" },
          },
        ],
      },
    },
    {
      type: "action.result",
      data: {
        turnId: "turn",
        status: "completed",
        result: {
          kind: "tool-result",
          toolName: "get_logs",
          callId: "browser-test-call",
          output: {
            logs: [
              {
                id: "log-17",
                deploymentId: "B",
                level: "error",
                message: "Startup failed: DATABASE_URL is missing.",
              },
            ],
          },
        },
      },
    },
    { type: "result.completed", data: { turnId: "turn", result: answer } },
  ];
  for (const [index, event] of events.entries())
    await runs.appendEvent(runId, {
      ...event,
      meta: { id: `test-event-${index}`, at: new Date().toISOString() },
    });
  await runs.finish(runId, {
    status: "completed",
    answer,
    message: "PRIVATE_TEST_CHAT",
  });
  missingCitationId = await runs.create(input);
  const unsupportedAnswer = { ...answer, evidenceIds: ["log-404"] };
  for (const [index, event] of events.entries())
    await runs.appendEvent(missingCitationId, {
      ...event,
      data:
        event.type === "result.completed"
          ? { turnId: "turn", result: unsupportedAnswer }
          : event.data,
      meta: { id: `test-event-${index}`, at: new Date().toISOString() },
    });
  await runs.finish(missingCitationId, {
    status: "completed",
    answer: unsupportedAnswer,
    message: "",
  });
  const config = {
    modelId: "test/reviewer",
    system: "Review.",
    promptVersion: "ui-test-v1",
    schemaVersion: 1 as const,
    settings: {
      maxOutputTokens: 1000,
      maxRetries: 0 as const,
      timeoutMs: 1000,
      maxInputBytes: 65536,
    },
  };
  await reviewSavedRun(pool, runId, config, async (_input, { onResponse }) => {
    await onResponse({
      responseId: null,
      resolvedModelId: "test/reviewer",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        costUsd: null,
      },
    });
    return {
      summary: "The startup error supports the diagnosis.",
      missingEvidence: ["Configuration history."],
      claims: [
        {
          field: "diagnosis",
          quote: answer.diagnosis,
          verdict: "supported",
          explanation: "The retrieved error states this directly.",
          evidenceIds: ["log-17"],
        },
        {
          field: "uncertainty",
          quote: answer.uncertainty,
          verdict: "supported",
          explanation: "No change history was retrieved.",
          evidenceIds: [],
        },
      ],
    };
  });
  failedId = await runs.create(input);
  await runs.finish(failedId, { status: "failed", error: "PRIVATE_ERROR" });
  cancelledId = await runs.create(input);
  await runs.finish(cancelledId, {
    status: "cancelled",
    error: "User cancelled.",
  });
  emptyId = await runs.create({ ...input, deploymentId: "C" });
  await runs.finish(emptyId, {
    status: "failed",
    error: "No completed answer.",
  });
});
test.afterAll(async () => {
  await deleteTrials(pool, trials);
  await pool.end();
});

test("Safari timestamp hydration: saved runs and reviews", async ({ baseURL }) => {
  const browser = await webkit.launch({ channel: undefined });
  try {
    const page = await browser.newPage({ baseURL, timezoneId: "Asia/Tokyo" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /hydrat/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/runs");
    await expect(page.getByRole("button", { name: "New investigation" })).toBeVisible();
    await page.goto(`/runs/${runId}`);
    await page.locator(".workspace-answer .run-metadata summary").click();
    await expect(page.locator(".workspace-answer .run-metadata")).toContainText("UTC");
    await page.reload();
    await page.locator(".workspace-answer").getByRole("button", { name: "log-17", exact: true }).click();
    await expect(page.locator(".evidence-log[data-selected=true]")).toContainText("Startup failed");
    await expect(page.getByRole("region", { name: "Independent review" })).toContainText("The startup error supports the diagnosis.");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("opens the workbench, preserves its filters, and switches theme", async ({
  page,
}) => {
  await page.goto("/runs");
  await expect(
    page.getByRole("heading", { name: "Investigations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New investigation" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Filter deployment" }).click();
  await page.getByRole("option", { name: "Deployment B", exact: true }).click();
  await expect(page).toHaveURL(/deployment=B/);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Filter deployment" }),
  ).toContainText("Deployment B");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("keeps the page usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/runs");
  await expect(
    page.getByRole("heading", { name: "Investigations", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("follows a citation to the received log, trace, and separate review after refresh", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByText("DATABASE_URL is missing.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Investigation activity" }),
  ).toBeVisible();
  await page
    .locator(".workspace-answer")
    .getByRole("button", { name: "log-17", exact: true })
    .click();
  await expect(page).toHaveURL(/log=log-17/);
  await expect(page.locator(".receipt")).toContainText("browser-test-call");
  await page.reload();
  await expect(page.locator(".evidence-log[data-selected=true]")).toContainText(
    "Startup failed",
  );
  await expect(
    page
      .getByRole("region", { name: "Independent review" })
      .getByText("The startup error supports the diagnosis."),
  ).toBeVisible();
  await expect(page.getByText("Configuration history.")).toBeVisible();
  await expect(
    page.getByText("Model judgments are advisory.", { exact: false }),
  ).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("PRIVATE_TEST");
  expect(errors).toEqual([]);
});

test("opens evidence in a keyboard accessible phone drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/runs/${runId}`);
  const button = page
    .locator(".workspace-answer")
    .getByRole("button", { name: "log-17", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("browser-test-call");
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await drawer.getByRole("button", { name: "View in activity" }).click();
  await expect(drawer).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "get_logs: 1 logs returned" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".context/mobile-activity-check.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("main *")]
      .filter(
        (element) => element.getBoundingClientRect().right > innerWidth + 1,
      )
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        right: element.getBoundingClientRect().right,
      }))
      .slice(0, 12),
  );
  expect(overflow).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("shows failures and cancellations without presenting a completed diagnosis", async ({
  page,
}) => {
  for (const [id, status] of [
    [failedId, "Failed"],
    [cancelledId, "Cancelled"],
    [emptyId, "Failed"],
  ]) {
    await page.goto(`/runs/${id}`);
    await expect(
      page.locator(".workspace-heading").getByText(status, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No completed answer" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review answer" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("complementary", { name: "Investigation activity" }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(
      "PRIVATE_ERROR",
    );
  }
});

test("renders offline controls and does not submit model work", async ({
  page,
}) => {
  let submissions = 0;
  await page.route("**/api/runner", (route) =>
    route.fulfill({
      json: { online: false, enabled: true, busy: false, activeJob: null },
    }),
  );
  await page.route("**/api/jobs", (route) => {
    submissions++;
    return route.fulfill({
      status: 503,
      json: { error: { message: "offline" } },
    });
  });
  await page.goto("/runs");
  await page.getByRole("button", { name: "New investigation" }).click();
  await expect(page.getByRole("dialog")).toContainText("Worker offline");
  await expect(
    page.getByRole("button", { name: "Run investigation", exact: true }),
  ).toBeDisabled();
  expect(submissions).toBe(0);
});

test("shows an unreceived citation as a failure, even when execution completed", async ({
  page,
}) => {
  await page.goto(`/runs/${missingCitationId}`);
  const check = page
    .locator(".check-row")
    .filter({ hasText: "Citations refer to received logs" });
  await expect(check).toContainText("Failed");
  await page.getByRole("button", { name: "log-404 · unavailable" }).click();
  await expect(
    page.getByText("log-404 was not found in the received evidence."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect log-404" }),
  ).toHaveCount(0);
});

test("keeps completed progress open and only expands steps with details", async ({
  page,
}) => {
  const runs = createRunStore(pool);
  const id = await runs.create({
    trialId: trials[0],
    deploymentId: "C",
    task: "Investigate C with empty logs",
    instructions: "",
    agentConfigSource: "",
  });
  let submissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/jobs"))
      submissions++;
  });
  const record = (eventId: string, type: string, data: unknown) =>
    runs.appendEvent(id, {
      type,
      data,
      meta: { id: eventId, at: new Date().toISOString() },
    });
  await page.goto(`/runs/${id}`);
  await expect(
    page.getByRole("complementary", { name: "Investigation activity" }),
  ).toBeVisible();
  await expect(
    page.getByText("Preparing investigation", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Preparing investigation:/ }),
  ).toHaveCount(0);
  await record("model-1", "step.started", {
    modelId: "test/model",
    turnId: "turn",
  });
  const model = page
    .getByText("Requesting a model response", { exact: true })
    .first();
  await expect(model).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Requesting a model response:/ }),
  ).toHaveCount(0);
  await record("request", "actions.requested", {
    turnId: "turn",
    actions: [
      {
        kind: "tool-call",
        toolName: "get_logs",
        callId: "live-call",
        input: { deploymentId: "C" },
      },
    ],
  });
  const tool = page.getByRole("button", {
    name: "get_logs: Requested · Deployment C",
  });
  await expect(tool).toBeVisible();
  await tool.click(); // Collapse the automatically expanded current tool.
  await tool.click(); // Explicit expansion must survive future snapshots.
  await record("result", "action.result", {
    turnId: "turn",
    status: "completed",
    result: {
      kind: "tool-result",
      toolName: "get_logs",
      callId: "live-call",
      output: { logs: [] },
    },
  });
  await expect(
    page.getByText("The tool returned an empty log list."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "get_logs: 0 logs returned" }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "get_logs: 0 logs returned" }),
  ).toHaveCount(1);
  const answer = {
    diagnosis: "There is insufficient evidence to diagnose C.",
    evidenceIds: [],
    uncertainty: "The returned log list is empty.",
  };
  await record("answer", "result.completed", {
    turnId: "turn",
    result: answer,
  });
  await runs.finish(id, { status: "completed", answer, message: "" });
  await expect(page.getByText(answer.diagnosis, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Investigation activity" }),
  ).toBeVisible();
  const panel = page.getByRole("complementary", {
    name: "Investigation activity",
  });
  await expect(
    page
      .locator(".workspace-main-panel")
      .getByRole("region", { name: "Evidence checks", exact: true }),
  ).toBeVisible();
  const investigation = panel.getByRole("region", {
    name: "Investigator steps",
  });
  await expect(investigation).toContainText("Answer saved");
  await expect(investigation).not.toContainText("Evidence checks");
  await expect(
    investigation.getByRole("button", { name: /Answer saved/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "get_logs: 0 logs returned" }),
  ).toHaveCount(1);
  await page.reload();
  await expect(panel).toBeVisible();
  expect(submissions).toBe(0);
});

test("resizes activity with the keyboard and keeps legacy trace links usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/runs/${runId}?tab=trace&event=test-event-1&log=log-17`);
  await expect(
    page.locator(".activity-panel .evidence-log[data-selected=true]"),
  ).toContainText("Startup failed");
  const handle = page.getByRole("separator", { name: "Resize activity panel" });
  await expect(handle).toHaveAttribute("aria-valuenow", /\d/);
  const value = await handle.getAttribute("aria-valuenow");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).not.toHaveAttribute("aria-valuenow", value!);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Close activity" }).click();
  await expect(
    page.getByRole("complementary", { name: "Investigation activity" }),
  ).not.toBeVisible();
  await page.goto(`/runs/${runId}?tab=review`);
  await expect(
    page
      .getByRole("region", { name: "Independent review" })
      .getByText("The startup error supports the diagnosis."),
  ).toBeVisible();
});

test("reconnects without losing evidence and only cancels on an explicit action", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get(`/api/runs/${runId}`)).json();
  const id = "10000000-0000-4000-8000-000000000001";
  let offline = true,
    cancellations = 0,
    submissions = 0;
  let job = {
    id,
    kind: "review",
    status: "running",
    runId,
    reviewId: null,
    error: null,
    cancelRequested: false,
  };
  await page.route(`**/api/runs/${runId}/stream`, (route) => {
    if (offline) return route.fulfill({ status: 503, body: "Unavailable" });
    const active = job.status === "running";
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify({ ...snapshot, activeJobId: active ? id : null, operations: [{ ...job, startedAt: new Date().toISOString(), finishedAt: null }] })}\n\n${active ? "" : "event: settled\ndata: {}\n\n"}`,
    });
  });
  await page.route(`**/api/jobs/${id}/cancel`, (route) => {
    cancellations++;
    job = { ...job, status: "cancelled", cancelRequested: true };
    return route.fulfill({ json: job });
  });
  await page.route("**/api/jobs", (route) => {
    submissions++;
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByText(
      "Connection interrupted. Showing the last saved view while reconnecting.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("DATABASE_URL is missing.", { exact: true }),
  ).toBeVisible();
  expect(cancellations).toBe(0);
  offline = false;
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByText(
      "Review cancelled. The saved investigation and earlier reviews remain available.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("DATABASE_URL is missing.", { exact: true }),
  ).toBeVisible();
  expect(cancellations).toBe(1);
  expect(submissions).toBe(0);
});

test("starts a separate review, keeps the answer visible, and selects earlier attempts", async ({
  page,
  request,
}) => {
  const snapshot = await (await request.get(`/api/runs/${runId}`)).json();
  const jobId = "20000000-0000-4000-8000-000000000001";
  const reviewId = "20000000-0000-4000-8000-000000000002";
  let started = false,
    completed = false,
    submissions = 0;
  await page.route("**/api/jobs", (route) => {
    submissions++;
    expect(route.request().postDataJSON()).toMatchObject({
      kind: "review",
      runId,
    });
    started = true;
    return route.fulfill({
      status: 202,
      json: {
        id: jobId,
        kind: "review",
        status: "queued",
        runId,
        reviewId: null,
        cancelRequested: false,
        error: null,
      },
    });
  });
  await page.route(`**/api/runs/${runId}/stream`, (route) => {
    const status = completed ? "completed" : "running";
    const value = !started
      ? snapshot
      : {
          ...snapshot,
          activeJobId: completed ? null : jobId,
          operations: [
            {
              id: jobId,
              kind: "review",
              status,
              reviewId,
              cancelRequested: false,
              startedAt: snapshot.startedAt,
              finishedAt: null,
            },
          ],
          reviews: [
            {
              ...snapshot.reviews[0],
              id: reviewId,
              status,
              review: completed
                ? {
                    ...snapshot.reviews[0].review,
                    summary: "A second saved review.",
                  }
                : null,
            },
            ...snapshot.reviews,
          ],
          activity: [
            ...snapshot.activity,
            {
              id: `${reviewId}:response`,
              operationId: jobId,
              actor: "reviewer",
              kind: "review",
              reviewId,
              title: completed ? "Review completed" : "Reviewing the answer",
              detail: "test/reviewer",
              status,
              at: snapshot.startedAt,
              finishedAt: null,
              durationMs: null,
              eventIds: [],
            },
          ],
        };
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: snapshot\ndata: ${JSON.stringify(value)}\n\n${!started || completed ? "event: settled\ndata: {}\n\n" : ""}`,
    });
  });
  await page.goto(`/runs/${runId}`);
  const panel = page.getByRole("complementary", {
    name: "Investigation activity",
  });
  await panel
    .getByRole("button", { name: "Review answer", exact: true })
    .click();
  await expect(
    page.getByText("Reviewing the saved answer and evidence…"),
  ).toBeVisible();
  await expect(
    page.getByText("DATABASE_URL is missing.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("region", { name: "Review activity" })
      .getByText("Reviewing the answer", { exact: true }),
  ).toBeVisible();
  completed = true;
  await expect(page.getByText("A second saved review.")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Investigation activity" }),
  ).toBeVisible();
  const result = page.locator(".workspace-main-panel").getByRole("button", {
    name: "Review result",
    exact: true,
  });
  await expect(result).toHaveAttribute("aria-expanded", "true");
  await result.click();
  await expect(page.getByText("A second saved review.")).not.toBeVisible();
  await result.click();
  await expect(
    page.locator(".workspace-main-panel").getByText("A second saved review."),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Review attempt" }).click();
  await page.getByRole("option", { name: /Earlier attempt 1/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Independent review" })
      .getByText("The startup error supports the diagnosis."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Independent review" })
      .getByText("The startup error supports the diagnosis."),
  ).toBeVisible();
  expect(submissions).toBe(1);
});

test("scrolls activity only on request and hides Latest at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const runs = createRunStore(pool);
  const id = await runs.create({
    trialId: trials[0],
    deploymentId: "C",
    task: "Activity scrolling fixture",
    instructions: "",
    agentConfigSource: "",
  });
  for (let index = 0; index < 24; index++)
    await runs.appendEvent(id, {
      type: "step.started",
      data: { modelId: `test/model-${index}` },
      meta: { id: `step-${index}`, at: new Date().toISOString() },
    });
  await page.goto(`/runs/${id}`);
  const scroller = page.locator(".activity-scroll");
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    page.getByRole("button", { name: "Latest activity" }),
  ).toBeVisible();
  await runs.appendEvent(id, {
    type: "step.started",
    data: { modelId: "test/new-step" },
    meta: { id: "new-step", at: new Date().toISOString() },
  });
  await expect(page.getByText("test/new-step", { exact: true })).toBeAttached();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Latest activity" }).click();
  await expect
    .poll(() => scroller.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
    ))
    .toBeLessThan(2);
  const latest = page.getByRole("button", { name: "Latest activity" });
  // Clicking or wheeling at the bottom must not leave a stale button visible.
  await scroller.dispatchEvent("pointerdown");
  await expect(latest).toBeHidden();
  await scroller.hover();
  await page.mouse.wheel(0, 100);
  await expect(latest).toBeHidden();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 80;
  });
  await expect(latest).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 20;
  });
  await expect(latest).toBeHidden();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(latest).toBeHidden();
  const bottom = await scroller.evaluate((element) => element.scrollTop);
  await runs.appendEvent(id, {
    type: "step.started",
    data: { modelId: "test/after-manual-jump" },
    meta: { id: "after-manual-jump", at: new Date().toISOString() },
  });
  await expect(page.getByText("test/after-manual-jump", { exact: true })).toBeAttached();
  await expect(latest).toHaveCount(0);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(bottom);
  await page.getByRole("button", { name: "Close activity" }).click();
  await page.getByRole("button", { name: "Show progress" }).click();
  await expect(scroller).toBeVisible();
  await expect(latest).toHaveCount(0);
  // Manual scrolling to the bottom consumes the control as well.
  await page.reload();
  await expect(latest).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(latest).toHaveCount(0);
  await scroller.evaluate(async (element) => {
    element.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(latest).toHaveCount(0);
  await runs.finish(id, { status: "cancelled", error: "Fixture finished" });
});

test("keeps desktop columns fixed while progress and results grow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const runs = createRunStore(pool);
  const id = await runs.create({
    trialId: trials[0],
    deploymentId: "C",
    task: "Read this task without losing your place. ".repeat(100),
    instructions: "",
    agentConfigSource: "",
  });
  const record = (index: number) =>
    runs.appendEvent(id, {
      type: "step.started",
      data: { modelId: `test/layout-${index}` },
      meta: { id: `layout-${index}`, at: new Date().toISOString() },
    });
  for (let index = 0; index < 12; index++) await record(index);
  await page.goto(`/runs/${id}`);
  await expect(
    page.getByText("test/layout-11", { exact: true }),
  ).toBeAttached();
  const left = page.locator(".workspace-results-scroll");
  const right = page.locator(".activity-scroll");
  // Content must grow inside the viewport, not make the document taller.
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(801);
  await left.evaluate((element) => {
    element.scrollTop = 120;
  });
  await expect
    .poll(() => left.evaluate((element) => element.scrollTop))
    .toBe(120);
  const leftNode = await left.elementHandle();
  const rightNode = await right.elementHandle();
  const frame = await page.locator(".workspace-layout").boundingBox();
  const leftFrame = await left.boundingBox();
  const rightFrame = await right.boundingBox();
  await record(12);
  await expect(
    page.getByText("test/layout-12", { exact: true }),
  ).toBeAttached();
  expect(await right.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await left.evaluate((element) => element.scrollTop)).toBe(120);
  await expect(page.getByRole("button", { name: "Latest results" })).toBeVisible();
  const answer = {
    diagnosis: "A result that grows naturally. ".repeat(100),
    evidenceIds: [],
    uncertainty: "No logs retrieved.",
  };
  await runs.finish(id, { status: "completed", answer, message: "" });
  await expect(page.locator(".answer-text")).toContainText(
    "A result that grows naturally.",
  );
  expect(await left.evaluate((element) => element.scrollTop)).toBe(120);
  for (const [locator, before] of [
    [page.locator(".workspace-layout"), frame],
    [left, leftFrame],
    [right, rightFrame],
  ] as const) {
    const after = await locator.boundingBox();
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(after![key] - before![key])).toBeLessThanOrEqual(1);
  }
  expect(
    await leftNode!.evaluate(
      (node) => node === document.querySelector(".workspace-results-scroll"),
    ),
  ).toBe(true);
  expect(
    await rightNode!.evaluate(
      (node) => node === document.querySelector(".activity-scroll"),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1400);
});

test("keeps incoming results still until Latest results is clicked", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const runs = createRunStore(pool);
  const id = await runs.create({
    trialId: trials[0], deploymentId: "C", task: "Watch the answer arrive.",
    instructions: "", agentConfigSource: "",
  });
  for (let index = 0; index < 12; index++)
    await runs.appendEvent(id, {
      type: "step.started",
      data: { modelId: `test/result-follow-${index}` },
      meta: { id: `result-follow-${index}`, at: new Date().toISOString() },
    });
  await page.goto(`/runs/${id}`);
  const left = page.getByRole("region", { name: "Investigation results" });
  await expect(left).toBeVisible();
  const right = page.getByRole("region", { name: "Activity timeline" });
  await expect(right).toBeVisible();
  expect(await right.evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.getByRole("button", { name: "Latest activity" })).toBeVisible();
  const rightTop = await right.evaluate(element => element.scrollTop);
  await runs.finish(id, {
    status: "completed",
    answer: {
      diagnosis: "Incoming investigation result. ".repeat(160),
      evidenceIds: [], uncertainty: "No logs retrieved.",
    },
    message: "",
  });
  await expect(page.locator(".answer-text")).toContainText("Incoming investigation result.");
  const latest = page.getByRole("button", { name: "Latest results" });
  await expect(latest).toBeVisible();
  await expect(latest).toHaveCount(1);
  expect(await left.evaluate(element => element.scrollTop)).toBe(0);
  await latest.click();
  await expect.poll(() => left.evaluate(element =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThan(2);
  expect(await left.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Latest results" })).toBeHidden();
  await left.evaluate(async (element) => {
    element.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(latest).toHaveCount(0);
  await page.locator(".workspace-answer .run-metadata summary").click();
  await expect(page.locator(".run-metadata")).toHaveAttribute("open", "");
  await expect(latest).toHaveCount(0);
  expect(await right.evaluate(element => element.scrollTop)).toBe(rightTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Reaching the bottom manually also consumes the one-time control.
  await page.reload();
  await expect(latest).toBeVisible();
  await left.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(latest).toHaveCount(0);
  await left.evaluate(async (element) => {
    element.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(latest).toHaveCount(0);
});

test("citation inspection scrolls only the timeline and preserves the result position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto(`/runs/${runId}`);
  const citation = page
    .getByRole("region", { name: "Independent review" })
    .getByRole("button", { name: "log-17", exact: true })
    .first();
  await citation.scrollIntoViewIfNeeded();
  const left = page.locator(".workspace-results-scroll");
  const before = await left.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);
  await citation.click();
  await expect(
    page.locator(".activity-panel .evidence-log[data-selected=true]"),
  ).toContainText("Startup failed");
  // Citation inspection runs on the next animation frame and focuses the log
  // after scrolling it. Wait for that completed interaction before measuring.
  await expect(page.locator(".activity-panel .evidence-log[data-selected=true]")).toBeFocused();
  expect(await left.evaluate((element) => element.scrollTop)).toBe(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const rightBefore = await page
    .locator(".activity-scroll")
    .evaluate((element) => element.scrollTop);
  await left.hover();
  await page.mouse.wheel(0, -150);
  await expect
    .poll(() => left.evaluate((element) => element.scrollTop))
    .toBeLessThan(before);
  expect(
    await page
      .locator(".activity-scroll")
      .evaluate((element) => element.scrollTop),
  ).toBe(rightBefore);
});

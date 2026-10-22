import { expect, it } from "vitest";
import { projectActivity, type ActivityRun } from "../src/activity";

const event = (id: string, type: string, data: unknown) => ({
  meta: { id, at: "2026-10-21T12:00:00.000Z" },
  type,
  data,
});
const request = (id: string, turnId = "turn", callId = "call") =>
  event(id, "actions.requested", {
    turnId,
    actions: [
      {
        kind: "tool-call",
        toolName: "get_logs",
        callId,
        input: { deploymentId: "B", secret: "PRIVATE" },
      },
    ],
  });
const result = (
  id: string,
  turnId = "turn",
  status = "completed",
  logs: unknown[] = [],
) =>
  event(id, "action.result", {
    turnId,
    status,
    result: {
      kind: "tool-result",
      toolName: "get_logs",
      callId: "call",
      output: { logs },
      error: "PRIVATE_FAILURE",
    },
  });
function run(
  events: ActivityRun["events"],
  status: ActivityRun["status"] = "running",
): ActivityRun {
  return {
    id: "run",
    startedAt: "2026-10-21T11:59:00.000Z",
    finishedAt: null,
    status,
    events,
    answer: null,
  };
}

it("pairs tool requests and results by turn and call, with stable IDs as results arrive", () => {
  const before = projectActivity(run([request("a")])).filter(
    (i) => i.kind === "tool",
  );
  const after = projectActivity(
    run([request("a"), request("b", "other"), result("c")]),
  ).filter((i) => i.kind === "tool");
  expect(after).toHaveLength(2);
  expect(after[0]).toMatchObject({
    id: before[0].id,
    status: "completed",
    detail: "0 logs returned",
    eventIds: ["a", "c"],
  });
  expect(after[1].status).toBe("running");
  expect(JSON.stringify(after)).not.toContain("PRIVATE");
});

it("deduplicates replayed events and repeated calls without losing evidence links", () => {
  const items = projectActivity(
    run([request("a"), request("a"), request("b"), result("c"), result("d")]),
  ).filter((i) => i.kind === "tool");
  expect(items).toHaveLength(1);
  expect(items[0].eventIds).toEqual(["a", "b", "c", "d"]);
  expect(items[0].tool?.results).toHaveLength(1);
});

it("shows failure and unmatched results without presenting them as retrieved evidence", () => {
  const failed = projectActivity(
    run([request("a"), result("b", "turn", "failed")]),
  ).find((i) => i.kind === "tool")!;
  expect(failed.status).toBe("failed");
  expect(failed.tool?.results[0]).toMatchObject({
    logs: null,
    error: expect.any(String),
  });
  const unmatched = projectActivity(
    run([request("a"), result("b", "other")]),
  ).filter((i) => i.kind === "tool");
  expect(unmatched).toHaveLength(2);
  expect(unmatched[1].status).toBe("interrupted");
});

it("settles unfinished tools explicitly and never invents a completed answer", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const items = projectActivity(run([request("a")], status));
    expect(items.find((i) => i.kind === "tool")?.status).toBe(
      status === "failed" ? "interrupted" : "cancelled",
    );
    expect(items.some((i) => i.kind === "answer")).toBe(false);
    expect(items.at(-1)?.status).toBe(status);
  }
});

it("keeps invalid and conflicting outputs visible instead of claiming success", () => {
  const items = projectActivity(
    run([
      request("a"),
      result("b"),
      result("c", "turn", "completed", [{ invalid: true }]),
    ]),
  );
  expect(items.find((i) => i.kind === "tool")?.status).toBe("failed");
});

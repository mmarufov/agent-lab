import { existsSync } from "node:fs";
import { appendFile, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DailyCaptureError, dailyCapturesDir, readDailyCapture, verifyCapture } from "../src/daily-evidence";
import {
  CLEAN_CAPTURE_ID,
  CONTROLLER_ONLY,
  capturesDir,
  controllerRecords,
  fileHash,
  http,
  incidentEvidence,
  log,
  removeCaptureDirs,
  writeCapture,
} from "./daily-capture-fixture";

afterEach(removeCaptureDirs);

const OTHER_ID = "20261022T060000Z-abcdef";

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DailyCaptureError);
  return error as DailyCaptureError;
}

describe("readDailyCapture", () => {
  it("returns the evidence records unchanged and in recorded order, with each file's SHA-256", async () => {
    const root = await capturesDir();
    const dir = await writeCapture(root);
    const capture = await readDailyCapture(root, CLEAN_CAPTURE_ID);

    const evidence = incidentEvidence();
    expect(capture.captureId).toBe(CLEAN_CAPTURE_ID);
    expect(capture.observations).toEqual(evidence.filter((record) => record.kind === "http"));
    expect(capture.logs).toEqual(evidence.filter((record) => record.kind === "log"));
    for (const name of ["manifest.json", "evidence.jsonl", "controller.jsonl"] as const)
      expect(capture.sha256[name]).toBe(fileHash(await readFile(join(dir, name), "utf8")));
    // Only evidence comes back: no manifest, outcomes, controller records, or paths.
    expect(Object.keys(capture).sort()).toEqual(["captureId", "logs", "observations", "sha256"]);
    expect(JSON.stringify(capture)).not.toContain(CONTROLLER_ONLY);
    expect(JSON.stringify(capture)).not.toContain(root);
  });

  it("keeps what was observed: a 200 during the outage, a timeout without a status, errors, and truncation markers", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    const { observations, logs } = await readDailyCapture(root, CLEAN_CAPTURE_ID);
    const byId = new Map(observations.map((record) => [record.id, record]));

    expect(byId.get("http-0004")).toMatchObject({ path: "/healthz", outcome: "response", response: { status: 200 } });
    expect(byId.get("http-0005")).toMatchObject({ path: "/feed", outcome: "response", response: { status: 500 } });
    expect(byId.get("http-0007")).toEqual(expect.objectContaining({ outcome: "timeout", elapsedMs: 5001.2, deadlineMs: 5000 }));
    expect(byId.get("http-0007")).not.toHaveProperty("response");
    expect(byId.get("http-0008")).toMatchObject({ outcome: "network_error", error: { code: "UND_ERR_SOCKET" } });
    expect(byId.get("http-0009")).toMatchObject({ response: { bodyTruncated: true, bodyBytes: 300_000, body: "x".repeat(16) } });
    // Repeated lines stay separate records; a missing Docker timestamp stays null.
    expect(logs.filter((record) => record.message.startsWith("psycopg.errors.AdminShutdown"))).toHaveLength(2);
    expect(logs.at(-1)).toMatchObject({ id: "log-api-0006", timestamp: null });
  });

  it("accepts a completed capture whose outage or recovery outcomes failed: what was observed is still evidence", async () => {
    const root = await capturesDir();
    await writeCapture(root, {
      manifest: (manifest) => ({
        ...manifest,
        outcomes: {
          ...manifest.outcomes,
          baselineHealthy: { ...manifest.outcomes.baselineHealthy, status: "failed" },
          outageObserved: { ...manifest.outcomes.outageObserved, status: "failed" },
          applicationRecovered: { ...manifest.outcomes.applicationRecovered, status: "not_evaluated" },
        },
      }),
    });
    expect((await readDailyCapture(root, CLEAN_CAPTURE_ID)).observations).toHaveLength(10);
  });

  it("serves only completed captures with complete evidence and no invalid lines, while verifyCapture still reads the rest", async () => {
    for (const status of ["cancelled", "failed", "interrupted", "running"] as const) {
      const root = await capturesDir();
      const dir = await writeCapture(root, { manifest: (manifest) => ({ ...manifest, status }) });
      expect((await rejection(readDailyCapture(root, CLEAN_CAPTURE_ID))).code).toBe("rejected");
      // The recovery verifier still inspects an interrupted or cancelled recording.
      expect((await verifyCapture(dir)).manifest.status).toBe(status);
    }

    const incomplete = await capturesDir();
    await writeCapture(incomplete, {
      manifest: (manifest) => ({
        ...manifest,
        outcomes: { ...manifest.outcomes, evidenceComplete: { ...manifest.outcomes.evidenceComplete, status: "failed" } },
      }),
    });
    const error = await rejection(readDailyCapture(incomplete, CLEAN_CAPTURE_ID));
    expect(error.code).toBe("rejected");
    expect(error.message).not.toContain(CONTROLLER_ONLY);

    // An invalid line the manifest counted: intact for verifyCapture, refused as evidence.
    const evidence = incidentEvidence();
    const partial = await capturesDir();
    const dir = await writeCapture(partial, {
      evidence,
      evidenceText: `${evidence.map((record) => JSON.stringify(record)).join("\n")}\n{"kind":"log","id":"log-api-0099"`,
      invalidLines: 1,
    });
    expect((await verifyCapture(dir)).evidence).toHaveLength(evidence.length);
    expect((await rejection(readDailyCapture(partial, CLEAN_CAPTURE_ID))).message).toMatch(/1 invalid line/);
  });

  it("rejects malformed records, duplicate IDs, mismatched counts or hashes, and a manifest for another capture", async () => {
    const malformed = await capturesDir();
    await writeCapture(malformed, { evidence: [...incidentEvidence(), { ...log(7, "late"), stream: "stdin" } as never] });
    expect((await rejection(readDailyCapture(malformed, CLEAN_CAPTURE_ID))).message).toMatch(/record counts/);

    const duplicate = await capturesDir();
    await writeCapture(duplicate, { evidence: [...incidentEvidence(), http(3, "/readyz", 200)] });
    expect((await rejection(readDailyCapture(duplicate, CLEAN_CAPTURE_ID))).message).toMatch(/duplicate record IDs: http-0003/);

    // An evidence ID reused in controller.jsonl is a duplicate too.
    const shared = await capturesDir();
    await writeCapture(shared, { controller: [...controllerRecords(), { kind: "note", id: "ctl-0001", at: "2026-10-22T05:01:00.000Z", level: "info", message: "again" }] });
    expect((await rejection(readDailyCapture(shared, CLEAN_CAPTURE_ID))).message).toMatch(/duplicate record IDs: ctl-0001/);

    const appended = await capturesDir();
    const dir = await writeCapture(appended);
    await appendFile(join(dir, "evidence.jsonl"), `${JSON.stringify(log(8, "appended later"))}\n`);
    expect((await rejection(readDailyCapture(appended, CLEAN_CAPTURE_ID))).message).toMatch(/SHA-256/);

    const renamed = await capturesDir();
    await writeCapture(renamed, { captureId: OTHER_ID });
    await rename(join(renamed, OTHER_ID), join(renamed, CLEAN_CAPTURE_ID));
    expect((await rejection(readDailyCapture(renamed, CLEAN_CAPTURE_ID))).message).toMatch(`manifest names capture ${OTHER_ID}`);

    const unfinished = await capturesDir();
    await writeCapture(unfinished, { manifest: (manifest) => ({ ...manifest, artifacts: null }) });
    expect((await rejection(readDailyCapture(unfinished, CLEAN_CAPTURE_ID))).message).toMatch(/not been finalized/);

    const notJson = await capturesDir();
    await writeFile(join(await writeCapture(notJson), "manifest.json"), "{");
    expect((await rejection(readDailyCapture(notJson, CLEAN_CAPTURE_ID))).message).toMatch(/not a valid capture manifest/);
  });

  it("selects only by capture ID inside the captures directory and refuses symbolic links", async () => {
    const root = await capturesDir();
    const elsewhere = await capturesDir();
    await writeCapture(elsewhere);
    for (const id of ["../x", `${CLEAN_CAPTURE_ID}/..`, "/etc", "", "latest"])
      expect((await rejection(readDailyCapture(root, id))).code).toBe("invalid");

    await symlink(join(elsewhere, CLEAN_CAPTURE_ID), join(root, CLEAN_CAPTURE_ID));
    expect((await rejection(readDailyCapture(root, CLEAN_CAPTURE_ID))).message).toMatch(/symbolic link/);

    // A file replaced by a symlink to identical bytes is refused as well.
    const linked = await capturesDir();
    const dir = await writeCapture(linked);
    await rename(join(dir, "evidence.jsonl"), join(dir, "elsewhere.jsonl"));
    await symlink(join(dir, "elsewhere.jsonl"), join(dir, "evidence.jsonl"));
    expect((await rejection(readDailyCapture(linked, CLEAN_CAPTURE_ID))).message).toMatch(/evidence.jsonl is a symbolic link/);

    expect((await rejection(readDailyCapture(root, OTHER_ID))).code).toBe("missing");
    const missingFile = await capturesDir();
    await rm(join(await writeCapture(missingFile), "controller.jsonl"));
    const missing = await rejection(readDailyCapture(missingFile, CLEAN_CAPTURE_ID));
    expect(missing).toMatchObject({ code: "missing", message: `Capture ${CLEAN_CAPTURE_ID}: controller.jsonl is missing.` });
    // Errors name the capture and file, never a filesystem path.
    expect(missing.message).not.toContain(missingFile);
  });

  it("refuses files that differ from hashes pinned earlier, before using their contents", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    const pinned = (await readDailyCapture(root, CLEAN_CAPTURE_ID)).sha256;
    expect((await readDailyCapture(root, CLEAN_CAPTURE_ID, pinned)).logs).toHaveLength(7);

    // Rewritten consistently, so the capture verifies on its own, but it is no longer the granted recording.
    await writeCapture(root, { evidence: [...incidentEvidence(), log(7, "added after the grant")] });
    expect((await readDailyCapture(root, CLEAN_CAPTURE_ID)).logs).toHaveLength(8);
    const changed = await rejection(readDailyCapture(root, CLEAN_CAPTURE_ID, pinned));
    expect(changed).toMatchObject({ code: "changed", message: `Capture ${CLEAN_CAPTURE_ID}: manifest.json, evidence.jsonl changed after access was granted.` });
  });
});

// The real recording from pnpm daily:capture (gitignored, so only on this machine).
describe.skipIf(!existsSync(join(dailyCapturesDir(), CLEAN_CAPTURE_ID)))(`the recorded capture ${CLEAN_CAPTURE_ID}`, () => {
  it("reads its original outage failure and recovery observations", async () => {
    const capture = await readDailyCapture(dailyCapturesDir(), CLEAN_CAPTURE_ID);
    expect(capture.sha256["evidence.jsonl"]).toBe("b3021362880097f1c7acdfd7091f5cf59f0311408e68ff230bda697ebe2020e1");
    expect(capture.observations).toHaveLength(28);
    expect(capture.logs).toHaveLength(821);

    const status = (id: string) => {
      const record = capture.observations.find((observation) => observation.id === id);
      return record?.outcome === "response" ? record.response.status : record?.outcome;
    };
    // Healthy, then Daily's /feed fails with 500 when PostgreSQL stops, while
    // /healthz still answers 200; then requests time out; then /feed recovers.
    expect(["http-0002", "http-0007", "http-0008", "http-0009", "http-0012", "http-0024"].map(status)).toEqual([
      200, 200, 500, 503, "timeout", 200,
    ]);
    expect(capture.observations.filter((observation) => observation.outcome === "timeout")).toHaveLength(11);
    const message = (id: string) => capture.logs.find((record) => record.id === id)?.message;
    expect(message("log-api-0011")).toBe("ERROR app.main: Unhandled error on GET /feed");
    expect(message("log-api-0182")).toBe("psycopg.errors.AdminShutdown: terminating connection due to administrator command");
    expect(message("log-api-0793")).toBe("psycopg_pool.PoolTimeout: couldn't get a connection after 30.00 sec");
    // Daily's own logs; the controller's actions and database logs are not evidence.
    expect(capture.logs.every((record) => record.service === "daily-api")).toBe(true);
    expect(JSON.stringify(capture)).not.toMatch(/"ctl-\d|"log-db-|stop-database|baselineHealthy/);
  });
});

import { isDeepStrictEqual } from "node:util";
import { dailyCaptureIdSchema, type DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createPool } from "@agent-lab/lab/database";
import { dailyCapturesDir } from "@agent-lab/lab/daily-evidence";
import { getDailyHttpObservations, getDailyLogs, type DailyEvidenceConfig } from "../my-agent/agent/lib/daily-evidence";

// Reads one recorded Daily capture back through the HTTP clients the Eve tools
// use, and compares every record with the verified file. It starts no Docker
// container, creates no outage, and makes no model request.

async function main(signal: AbortSignal) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !dailyCaptureIdSchema.safeParse(args[0]).success)
    throw new Error("Usage: pnpm lab:daily-evidence <capture-id>, for example: pnpm lab:daily-evidence 20261022T050138Z-39b307");
  const captureId = args[0];
  const baseUrl = process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
  const pool = createPool();
  const access = createCaptureAccess(pool, dailyCapturesDir());
  let grantId: string | undefined;
  try {
    signal.throwIfAborted();
    // Only this trusted command reads the files directly and creates the grant.
    const { token, grant, capture } = await access.grant(captureId);
    grantId = grant.id;
    const evidenceSha256 = grant.sha256["evidence.jsonl"];
    console.log(`Capture ${captureId}`);
    console.log("  verified: completed recording, complete evidence, no invalid lines");
    console.log(`  evidence.jsonl sha256 ${evidenceSha256}`);
    console.log(`  ${capture.observations.length} HTTP observations, ${capture.logs.length} log lines`);
    console.log(`Access grant ${grant.id} expires ${grant.expiresAt}; its token goes to the clients and is never printed.`);

    const config: DailyEvidenceConfig = { baseUrl, token, captureId, evidenceSha256, signal };
    const http = await everyPage((cursor) => getDailyHttpObservations({ cursor }, config), (page) => page.observations);
    console.log(`\nget_daily_http_observations via ${baseUrl}: ${http.records.length} observations in ${http.pages} pages`);
    for (const record of http.records)
      console.log(`  ${record.id}  GET ${record.path.padEnd(9)}${outcome(record).padEnd(9)} ${record.elapsedMs} ms`);

    const logs = await everyPage((cursor) => getDailyLogs({ cursor }, config), (page) => page.logs);
    const count = (service: string) => logs.records.filter((record) => record.service === service).length;
    console.log(
      `\nget_daily_logs via ${baseUrl}: ${logs.records.length} lines in ${logs.pages} pages ` +
        `(daily-api ${count("daily-api")}, daily-gateway ${count("daily-gateway")})`,
    );
    const errors = await everyPage((cursor) => getDailyLogs({ messageContains: "error", cursor }, config), (page) => page.logs);
    console.log(`get_daily_logs with messageContains "error": ${errors.records.length} lines; the first 3:`);
    for (const record of errors.records.slice(0, 3)) console.log(`  ${record.id}  ${record.timestamp}  ${record.stream}  ${record.message}`);

    // The tools must return the verified file's records: same content, same order, none missing or repeated.
    requireSame("HTTP observations", http, capture.observations);
    requireSame("log lines", logs, capture.logs);
    console.log("\nEvery retrieved record matches the verified evidence.jsonl, in order, with nothing missing or repeated.");

    await access.revoke(grant.id);
    grantId = undefined;
    const refused = await getDailyLogs({ limit: 1 }, { ...config, signal: undefined }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (!refused?.includes("HTTP 401")) throw new Error(`The revoked token was not refused as unauthorized: ${refused ?? "it still read evidence"}.`);
    console.log(`Access grant ${grant.id} revoked; the same token is now refused:\n  ${refused}`);
  } finally {
    if (grantId) {
      await access.revoke(grantId).then(
        () => console.error(`Access grant ${grantId} revoked.`),
        () => console.error(`Could not revoke access grant ${grantId}; it expires within an hour.`),
      );
    }
    await pool.end();
  }
}

/** Every page from the first, following nextCursor. */
async function everyPage<Page extends { nextCursor: string | null; oversized: { id: string }[] }, Item>(
  read: (cursor: string | undefined) => Promise<Page>,
  records: (page: Page) => Item[],
) {
  const result = { records: [] as Item[], oversized: [] as string[], pages: 0 };
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    result.pages++;
    result.records.push(...records(page));
    result.oversized.push(...page.oversized.map((entry) => entry.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}

function requireSame(name: string, retrieved: { records: unknown[]; oversized: string[] }, verified: unknown[]) {
  if (retrieved.oversized.length) throw new Error(`${name} too large for a page: ${retrieved.oversized.join(", ")}.`);
  if (isDeepStrictEqual(retrieved.records, verified)) return;
  const index = verified.findIndex((record, i) => !isDeepStrictEqual(record, retrieved.records[i]));
  throw new Error(
    index < 0
      ? `Retrieved ${retrieved.records.length} ${name}; evidence.jsonl has ${verified.length}.`
      : `Retrieved ${name} differ from evidence.jsonl, first at position ${index + 1} of ${verified.length}.`,
  );
}

const outcome = (record: DailyHttpObservation) => (record.outcome === "response" ? String(record.response.status) : record.outcome);

const controller = new AbortController();
for (const name of ["SIGINT", "SIGTERM"] as const)
  process.once(name, () => {
    console.error(`\n${name}: stopping and revoking the access grant.`);
    controller.abort(name);
  });

void main(controller.signal).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "The Daily evidence demo failed.";
  console.error(controller.signal.aborted ? "Cancelled." : message);
  if (/capture_missing|capture_changed/.test(message))
    console.error("The lab service reads captures from its own working directory. Run pnpm dev from this repository.");
  process.exitCode = controller.signal.reason === "SIGTERM" ? 143 : controller.signal.aborted ? 130 : 1;
});

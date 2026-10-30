import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  dailyCaptureControllerSchema,
  dailyCaptureEvidenceSchema,
  dailyCaptureIdSchema,
  dailyCaptureManifestSchema,
  type DailyApplicationLog,
  type DailyCaptureControllerRecord,
  type DailyCaptureEvidence,
  type DailyCaptureManifest,
  type DailyHttpObservation,
} from "@agent-lab/contracts/daily-capture";

// Reads and verifies what pnpm daily:capture saved. No Docker, network, or
// database code is reachable from here, so both the capture controller and
// the Next.js evidence endpoints use it.

export const EVIDENCE = "evidence.jsonl";
export const CONTROLLER = "controller.jsonl";
export const MANIFEST = "manifest.json";
const CAPTURE_FILES = [MANIFEST, EVIDENCE, CONTROLLER] as const;
type CaptureFile = (typeof CAPTURE_FILES)[number];

/** SHA-256 of each finalized file, keyed by file name. */
export type CaptureFileHashes = Record<CaptureFile, string>;

/** Where pnpm daily:capture saves captures; commands and Next.js run from the repository root. */
export const dailyCapturesDir = (root = process.cwd()) => join(root, ".context", "daily-sandbox", "captures");

/**
 * Why a capture cannot be read: missing files, files that fail verification,
 * files that differ from the hashes an access grant pinned, or a recording
 * that is not accepted as evidence. Messages name the capture and file, never
 * a filesystem path.
 */
export class DailyCaptureError extends Error {
  constructor(
    readonly code: "missing" | "invalid" | "changed" | "rejected",
    message: string,
  ) {
    super(message);
    this.name = "DailyCaptureError";
  }
}

/** Both JSONL artifacts of a capture, finalized or not: hashes, sizes, schema-valid records, and problems. */
export async function summarizeArtifacts(dir: string) {
  const label = `Capture ${basename(dir)}`;
  return summarize(await readCaptureFile(dir, EVIDENCE, label), await readCaptureFile(dir, CONTROLLER, label));
}

/**
 * Re-read a finalized capture of any status, including an interrupted one:
 * the manifest, both artifacts' SHA-256 and record counts, every record's
 * schema, and unique record IDs. Throws on any mismatch; returns the
 * validated records and the SHA-256 of each file.
 */
export async function verifyCapture(dir: string) {
  const label = `Capture ${basename(dir)}`;
  return verifyFiles(label, await readCaptureFiles(dir, label));
}

export interface DailyCaptureRecords {
  captureId: string;
  sha256: CaptureFileHashes;
  /** evidence.jsonl's HTTP observations and application logs, each in recorded order. */
  observations: DailyHttpObservation[];
  logs: DailyApplicationLog[];
}

/**
 * Select one capture by its ID under capturesDir and accept it as evidence:
 * a completed recording whose evidence is complete and whose files have no
 * invalid lines. The outage and recovery outcomes need not pass; an observed
 * failure is still evidence. With the hashes an access grant pinned, a changed
 * file is refused before its contents are used. Returns evidence records and
 * their source identity, never the manifest or controller records it checked.
 */
export async function readDailyCapture(
  capturesDir: string,
  captureId: string,
  pinned?: CaptureFileHashes,
): Promise<DailyCaptureRecords> {
  // The ID is the only selector, and its format admits no path separators.
  if (!dailyCaptureIdSchema.safeParse(captureId).success)
    throw new DailyCaptureError("invalid", "A capture is selected by an ID like 20261022T050138Z-39b307.");
  const label = `Capture ${captureId}`;
  const dir = join(capturesDir, captureId);
  const before = await captureDirectory(dir, label);
  const files = await readCaptureFiles(dir, label);
  const after = await captureDirectory(dir, label);
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new DailyCaptureError("invalid", `${label} was replaced while it was being read.`);

  if (pinned) {
    const changed = CAPTURE_FILES.filter((name) => sha256(files[name]) !== pinned[name]);
    if (changed.length)
      throw new DailyCaptureError("changed", `${label}: ${changed.join(", ")} changed after access was granted.`);
  }
  const verified = verifyFiles(label, files);
  if (verified.manifest.captureId !== captureId)
    throw new DailyCaptureError("invalid", `${label}: its manifest names capture ${verified.manifest.captureId}.`);
  const { status, outcomes } = verified.manifest;
  if (status !== "completed")
    throw new DailyCaptureError("rejected", `${label} is ${status}; only a completed recording is served as evidence.`);
  if (outcomes.evidenceComplete.status !== "passed")
    throw new DailyCaptureError("rejected", `${label}: its logs and observations were not all collected.`);
  const invalidLines = verified.artifacts[EVIDENCE].invalidLines + verified.artifacts[CONTROLLER].invalidLines;
  if (invalidLines)
    throw new DailyCaptureError("rejected", `${label} has ${invalidLines} invalid line(s); only intact files are served.`);
  return {
    captureId,
    sha256: verified.sha256,
    observations: verified.evidence.filter((record) => record.kind === "http"),
    logs: verified.evidence.filter((record) => record.kind === "log"),
  };
}

/** The capture's own directory: not a symbolic link, and not anything but a directory. */
async function captureDirectory(dir: string, label: string): Promise<Stats> {
  let stats: Stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
      throw new DailyCaptureError("missing", `${label} is not in the captures directory.`);
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new DailyCaptureError("invalid", `${label} is a symbolic link; only captures saved in the captures directory are read.`);
  if (!stats.isDirectory()) throw new DailyCaptureError("invalid", `${label} is not a directory.`);
  return stats;
}

async function readCaptureFiles(dir: string, label: string): Promise<Record<CaptureFile, Buffer>> {
  return {
    [MANIFEST]: await readCaptureFile(dir, MANIFEST, label),
    [EVIDENCE]: await readCaptureFile(dir, EVIDENCE, label),
    [CONTROLLER]: await readCaptureFile(dir, CONTROLLER, label),
  };
}

/** One file's bytes. O_NOFOLLOW refuses a symbolic link in place of the file. */
async function readCaptureFile(dir: string, name: CaptureFile, label: string) {
  let handle;
  try {
    handle = await open(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new DailyCaptureError("missing", `${label}: ${name} is missing.`);
    if (code === "ELOOP") throw new DailyCaptureError("invalid", `${label}: ${name} is a symbolic link.`);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new DailyCaptureError("invalid", `${label}: ${name} is not a regular file.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function verifyFiles(label: string, files: Record<CaptureFile, Buffer>) {
  let manifest: DailyCaptureManifest;
  try {
    manifest = dailyCaptureManifestSchema.parse(JSON.parse(files[MANIFEST].toString("utf8")));
  } catch {
    throw new DailyCaptureError("invalid", `${label}: ${MANIFEST} is not a valid capture manifest.`);
  }
  const artifacts = manifest.artifacts;
  if (!artifacts) throw new DailyCaptureError("invalid", `Capture ${manifest.captureId} has not been finalized.`);
  const summary = summarize(files[EVIDENCE], files[CONTROLLER]);
  for (const name of [EVIDENCE, CONTROLLER] as const) {
    const expected = artifacts[name],
      actual = summary.artifacts[name];
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new DailyCaptureError("invalid", `${name} in ${manifest.captureId} does not match the SHA-256 recorded in its manifest.`);
    if (actual.records !== expected.records || actual.invalidLines !== expected.invalidLines)
      throw new DailyCaptureError("invalid", `${name} in ${manifest.captureId} does not match the record counts in its manifest.`);
  }
  if (summary.duplicates.length)
    throw new DailyCaptureError("invalid", `${manifest.captureId}: duplicate record IDs: ${summary.duplicates.join(", ")}`);
  return {
    manifest,
    artifacts,
    evidence: summary.evidence,
    controller: summary.controller,
    sha256: {
      [MANIFEST]: sha256(files[MANIFEST]),
      [EVIDENCE]: summary.artifacts[EVIDENCE].sha256,
      [CONTROLLER]: summary.artifacts[CONTROLLER].sha256,
    },
  };
}

function summarize(evidenceBytes: Buffer, controllerBytes: Buffer) {
  const evidence = parseArtifact<DailyCaptureEvidence>(evidenceBytes, dailyCaptureEvidenceSchema);
  const controller = parseArtifact<DailyCaptureControllerRecord>(controllerBytes, dailyCaptureControllerSchema);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of [...evidence.records, ...controller.records]) (seen.has(id) ? duplicates : seen).add(id);
  const artifact = (file: typeof evidence | typeof controller) => ({
    sha256: file.sha256,
    bytes: file.bytes,
    records: file.records.length,
    invalidLines: file.invalid.length,
  });
  return {
    artifacts: { [EVIDENCE]: artifact(evidence), [CONTROLLER]: artifact(controller) } as NonNullable<DailyCaptureManifest["artifacts"]>,
    duplicates: [...duplicates],
    problems: [
      ...evidence.invalid.map((problem) => `${EVIDENCE} ${problem}`),
      ...controller.invalid.map((problem) => `${CONTROLLER} ${problem}`),
      ...(duplicates.size ? [`duplicate record IDs: ${[...duplicates].join(", ")}`] : []),
    ],
    evidence: evidence.records,
    controller: controller.records,
  };
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } };
}

/** Every line validated on its own, so one bad line in an interrupted capture leaves the rest readable. */
function parseArtifact<T>(bytes: Buffer, schema: Schema<T>) {
  const records: T[] = [];
  const invalid: string[] = [];
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        invalid.push(`line ${index + 1} is not JSON`);
        return;
      }
      const parsed = schema.safeParse(value);
      if (parsed.success) records.push(parsed.data);
      else {
        const issue = parsed.error.issues[0];
        invalid.push(`line ${index + 1}: ${issue?.path.join(".") || "record"} ${issue?.message ?? "is invalid"}`);
      }
    });
  return { sha256: sha256(bytes), bytes: bytes.length, records, invalid };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

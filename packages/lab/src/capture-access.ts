import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CONTROLLER, EVIDENCE, MANIFEST, readDailyCapture, type CaptureFileHashes } from "./daily-evidence";

// Read access to exactly one recorded Daily capture, for at most one hour. A
// trusted runner, never the model, verifies the capture and creates the grant.
// Whoever holds the token can read that capture's evidence and nothing else.
// PostgreSQL stores only this access metadata; the evidence stays in its files.

export class CaptureAccessError extends Error {
  constructor(
    readonly reason: "invalid" | "expired" | "revoked",
    message: string,
  ) {
    super(message);
    this.name = "CaptureAccessError";
  }
}

export interface CaptureGrant {
  id: string;
  captureId: string;
  /** What the capture's files were when access was granted. */
  sha256: CaptureFileHashes;
  createdAt: string;
  expiresAt: string;
}

interface GrantRow {
  id: string;
  capture_id: string;
  evidence_sha256: string;
  controller_sha256: string;
  manifest_sha256: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  expired: boolean;
}

export function createCaptureAccess(pool: Pool, capturesDir: string) {
  /**
   * Verify the capture as evidence, then grant one hour of access pinned to
   * its files. The token is returned only here and stored only as a hash.
   * Also returns the verified records the grant refers to.
   */
  async function grant(captureId: string) {
    const capture = await readDailyCapture(capturesDir, captureId);
    const token = randomBytes(32).toString("hex");
    const { rows } = await pool.query<GrantRow>(
      `INSERT INTO lab_capture_access_grants
         (id, capture_id, evidence_sha256, controller_sha256, manifest_sha256, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '1 hour')
       RETURNING *, false AS expired`,
      [
        randomUUID(),
        captureId,
        capture.sha256[EVIDENCE],
        capture.sha256[CONTROLLER],
        capture.sha256[MANIFEST],
        hashToken(token),
      ],
    );
    return { token, grant: toGrant(rows[0]), capture };
  }

  /** The grant a token carries, refused when unknown, revoked, or expired. */
  async function resolve(token: string): Promise<CaptureGrant> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new CaptureAccessError("invalid", "Invalid capture access token.");
    const { rows } = await pool.query<GrantRow>(
      "SELECT *, expires_at <= now() AS expired FROM lab_capture_access_grants WHERE token_hash = $1",
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) throw new CaptureAccessError("invalid", "Invalid capture access token.");
    if (row.revoked_at) throw new CaptureAccessError("revoked", "This capture access grant was revoked.");
    if (row.expired)
      throw new CaptureAccessError("expired", `This capture access grant expired at ${row.expires_at.toISOString()}.`);
    return toGrant(row);
  }

  /** The granted capture's evidence, read now and refused unless its files still match the pinned hashes. */
  async function read(token: string) {
    const granted = await resolve(token);
    return readDailyCapture(capturesDir, granted.captureId, granted.sha256);
  }

  /** True when this call revoked the grant; false when it was already revoked or does not exist. */
  async function revoke(id: string) {
    const result = await pool.query(
      "UPDATE lab_capture_access_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [id],
    );
    return result.rowCount === 1;
  }

  return { grant, resolve, read, revoke };
}

function toGrant(row: GrantRow): CaptureGrant {
  return {
    id: row.id,
    captureId: row.capture_id,
    sha256: {
      [MANIFEST]: row.manifest_sha256,
      [EVIDENCE]: row.evidence_sha256,
      [CONTROLLER]: row.controller_sha256,
    },
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

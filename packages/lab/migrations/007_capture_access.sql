-- Who may read one recorded Daily capture, and which exact files. The evidence
-- stays in its capture directory; a grant pins the SHA-256 of each finalized
-- file so every read can refuse files that changed after access was granted.
CREATE TABLE lab_capture_access_grants (
  id uuid PRIMARY KEY,
  capture_id text NOT NULL CHECK (capture_id ~ '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  controller_sha256 text NOT NULL CHECK (controller_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  -- Only the SHA-256 of the random bearer token is stored.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

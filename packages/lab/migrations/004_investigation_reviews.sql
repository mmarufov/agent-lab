CREATE TABLE lab_investigation_reviews (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES lab_investigation_runs(id) ON DELETE CASCADE,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  evidence_check jsonb NOT NULL CHECK (jsonb_typeof(evidence_check) = 'object'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  observation jsonb CHECK (jsonb_typeof(observation) = 'object'),
  review jsonb CHECK (jsonb_typeof(review) = 'object'),
  error text,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND review IS NULL AND error IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND review IS NOT NULL AND observation IS NOT NULL AND error IS NULL)
    OR (status IN ('failed', 'cancelled') AND finished_at IS NOT NULL AND review IS NULL AND error IS NOT NULL)
  )
);

CREATE INDEX investigation_reviews_by_run ON lab_investigation_reviews (run_id, started_at DESC, id DESC);

CREATE TABLE lab_worker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner uuid NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE lab_execution_jobs (
  id uuid PRIMARY KEY,
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  kind text NOT NULL CHECK (kind IN ('investigate', 'review')),
  run_id uuid REFERENCES lab_investigation_runs(id) ON DELETE CASCADE,
  review_id uuid REFERENCES lab_investigation_reviews(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  owner uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((status IN ('queued', 'running') AND finished_at IS NULL) OR
         (status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL))
);

-- A small local workbench admits only one outstanding operation.
CREATE UNIQUE INDEX one_active_lab_job ON lab_execution_jobs ((true)) WHERE status IN ('queued', 'running');
CREATE INDEX lab_jobs_by_run ON lab_execution_jobs (run_id, created_at DESC);

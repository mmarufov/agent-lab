CREATE TABLE lab_investigation_runs (
  id uuid PRIMARY KEY,
  trial_id uuid NOT NULL REFERENCES lab_trials(id) ON DELETE CASCADE,
  deployment_id text NOT NULL CHECK (length(deployment_id) > 0),
  task text NOT NULL,
  instructions text NOT NULL,
  instructions_sha256 text NOT NULL CHECK (instructions_sha256 ~ '^[a-f0-9]{64}$'),
  agent_config_source text NOT NULL,
  result_schema_version integer NOT NULL DEFAULT 1,
  session_id text,
  model_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  answer jsonb CHECK (jsonb_typeof(answer) = 'object'),
  assistant_message text,
  usage jsonb CHECK (jsonb_typeof(usage) = 'object'),
  error text,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND answer IS NULL AND error IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND answer IS NOT NULL AND error IS NULL)
    OR (status IN ('failed', 'cancelled') AND finished_at IS NOT NULL AND answer IS NULL AND error IS NOT NULL)
  )
);

CREATE TABLE lab_investigation_events (
  run_id uuid NOT NULL REFERENCES lab_investigation_runs(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, event_id),
  CHECK (payload -> 'meta' ->> 'id' = event_id)
);

CREATE INDEX investigation_events_in_order ON lab_investigation_events (run_id, sequence);

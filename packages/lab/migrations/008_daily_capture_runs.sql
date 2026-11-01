-- Investigations of one recorded Daily capture share the run and event tables
-- with simulated ones. source says which kind a run is; every existing row
-- investigated a simulated deployment and keeps doing so.

-- Lets a run reference its grant together with the file hashes the grant pinned.
ALTER TABLE lab_capture_access_grants
  ADD CONSTRAINT grant_pinned_files UNIQUE (id, capture_id, evidence_sha256, controller_sha256, manifest_sha256);

ALTER TABLE lab_investigation_runs
  ADD COLUMN source text NOT NULL DEFAULT 'simulated' CHECK (source IN ('simulated', 'daily_capture')),
  ALTER COLUMN trial_id DROP NOT NULL,
  ALTER COLUMN deployment_id DROP NOT NULL,
  ADD COLUMN capture_id text,
  ADD COLUMN capture_manifest_sha256 text,
  ADD COLUMN capture_evidence_sha256 text,
  ADD COLUMN capture_controller_sha256 text,
  ADD COLUMN capture_grant_id uuid,
  -- The settings the run actually used: tool mode, agent settings, deadlines, usage limits.
  ADD COLUMN configuration jsonb CHECK (jsonb_typeof(configuration) = 'object'),
  -- The versioned evidence-check report, frozen when the run finishes.
  ADD COLUMN evidence_report jsonb CHECK (jsonb_typeof(evidence_report) = 'object'),
  ADD CONSTRAINT capture_run_grant FOREIGN KEY
    (capture_grant_id, capture_id, capture_evidence_sha256, capture_controller_sha256, capture_manifest_sha256)
    REFERENCES lab_capture_access_grants (id, capture_id, evidence_sha256, controller_sha256, manifest_sha256),
  ADD CONSTRAINT run_source_fields CHECK (
    (source = 'simulated' AND trial_id IS NOT NULL AND deployment_id IS NOT NULL
      AND capture_id IS NULL AND capture_manifest_sha256 IS NULL AND capture_evidence_sha256 IS NULL
      AND capture_controller_sha256 IS NULL AND capture_grant_id IS NULL
      AND configuration IS NULL AND evidence_report IS NULL)
    -- All five grant columns are required, so the foreign key above always applies.
    OR (source = 'daily_capture' AND trial_id IS NULL AND deployment_id IS NULL AND case_id IS NULL
      AND capture_id IS NOT NULL AND capture_manifest_sha256 IS NOT NULL AND capture_evidence_sha256 IS NOT NULL
      AND capture_controller_sha256 IS NOT NULL AND capture_grant_id IS NOT NULL
      AND configuration IS NOT NULL AND result_schema_version = 3
      AND (status = 'running') = (evidence_report IS NULL))
  );

-- What a run investigated, and with which instructions and settings, never
-- changes after it is created. A frozen evidence report is never replaced.
CREATE FUNCTION preserve_run_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source, NEW.trial_id, NEW.deployment_id, NEW.capture_id, NEW.capture_manifest_sha256,
      NEW.capture_evidence_sha256, NEW.capture_controller_sha256, NEW.capture_grant_id, NEW.task,
      NEW.instructions, NEW.instructions_sha256, NEW.agent_config_source, NEW.result_schema_version,
      NEW.configuration)
    IS DISTINCT FROM
     (OLD.source, OLD.trial_id, OLD.deployment_id, OLD.capture_id, OLD.capture_manifest_sha256,
      OLD.capture_evidence_sha256, OLD.capture_controller_sha256, OLD.capture_grant_id, OLD.task,
      OLD.instructions, OLD.instructions_sha256, OLD.agent_config_source, OLD.result_schema_version,
      OLD.configuration)
    OR (OLD.evidence_report IS NOT NULL AND NEW.evidence_report IS DISTINCT FROM OLD.evidence_report)
  THEN
    RAISE EXCEPTION 'Investigation sources, settings, and frozen evidence reports are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_run_source BEFORE UPDATE ON lab_investigation_runs
  FOR EACH ROW EXECUTE FUNCTION preserve_run_source();

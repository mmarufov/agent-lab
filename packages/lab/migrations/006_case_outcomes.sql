ALTER TABLE lab_investigation_runs
  ADD COLUMN case_id text,
  ADD COLUMN case_version integer,
  ADD COLUMN case_snapshot jsonb,
  ADD COLUMN outcome_report jsonb,
  ADD CONSTRAINT case_snapshot_consistent CHECK (
    (case_id IS NULL AND case_version IS NULL AND case_snapshot IS NULL AND outcome_report IS NULL)
    OR (case_id IS NOT NULL AND case_version > 0 AND case_snapshot IS NOT NULL
      AND jsonb_typeof(case_snapshot) = 'object' AND result_schema_version = 2
      AND case_snapshot ->> 'id' = case_id
      AND (case_snapshot ->> 'version')::integer = case_version
      AND case_snapshot ->> 'trialId' = trial_id::text
      AND case_snapshot ->> 'deploymentId' = deployment_id)
  ),
  ADD CONSTRAINT outcome_report_object CHECK (outcome_report IS NULL OR jsonb_typeof(outcome_report) = 'object');

CREATE FUNCTION preserve_case_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.case_version IS DISTINCT FROM OLD.case_version
    OR NEW.case_snapshot IS DISTINCT FROM OLD.case_snapshot
    OR (OLD.outcome_report IS NOT NULL AND NEW.outcome_report IS DISTINCT FROM OLD.outcome_report)
  THEN
    RAISE EXCEPTION 'Case snapshots and saved outcome assessments are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_case_outcome BEFORE UPDATE ON lab_investigation_runs
  FOR EACH ROW EXECUTE FUNCTION preserve_case_outcome();

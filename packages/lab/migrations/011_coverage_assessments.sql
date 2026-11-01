-- Evidence coverage assessments of finished Daily runs, kept apart from model
-- reviews and from the evidence report frozen with each run. One assessment
-- exists per run, profile version, and evaluator version; changed rules get a
-- new version, so earlier assessments stay as they were. The assessment
-- document repeats its identity columns, and a check keeps the two equal.
CREATE TABLE lab_coverage_assessments (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES lab_investigation_runs(id) ON DELETE CASCADE,
  profile_version text NOT NULL CHECK (profile_version ~ '^[a-z0-9-]+-v[0-9]+$'),
  evaluator_version text NOT NULL CHECK (evaluator_version ~ '^[a-z0-9-]+-v[0-9]+$'),
  -- The run's integrity fingerprint, verified when the assessment was saved.
  integrity_version integer NOT NULL,
  integrity_sha256 text NOT NULL CHECK (integrity_sha256 ~ '^[a-f0-9]{64}$'),
  -- The recording the assessment read: the files the run's grant pinned.
  capture_id text NOT NULL,
  capture_manifest_sha256 text NOT NULL,
  capture_evidence_sha256 text NOT NULL,
  capture_controller_sha256 text NOT NULL,
  result text NOT NULL CHECK (result IN ('covered', 'missed', 'not_assessed')),
  -- Fact definitions, acceptable evidence records, retrieved matches, and missing evidence.
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
  assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, profile_version, evaluator_version),
  CONSTRAINT assessment_matches_columns CHECK (
    assessment ->> 'runId' = run_id::text
    AND assessment ->> 'profileVersion' = profile_version
    AND assessment ->> 'evaluatorVersion' = evaluator_version
    AND assessment ->> 'result' = result
    AND assessment -> 'integrity' ->> 'version' = integrity_version::text
    AND assessment -> 'integrity' ->> 'sha256' = integrity_sha256
    AND assessment ->> 'captureId' = capture_id
    AND assessment -> 'captureSha256' ->> 'manifest.json' = capture_manifest_sha256
    AND assessment -> 'captureSha256' ->> 'evidence.jsonl' = capture_evidence_sha256
    AND assessment -> 'captureSha256' ->> 'controller.jsonl' = capture_controller_sha256
  )
);

CREATE INDEX coverage_assessments_latest ON lab_coverage_assessments (assessed_at DESC, id DESC);

-- An assessment is saved only for a finished Daily run whose record verifies
-- against its fingerprint now, and it must name that fingerprint and the files
-- the run's grant pinned.
CREATE FUNCTION check_coverage_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lab_investigation_runs r
    WHERE r.id = NEW.run_id AND r.source = 'daily_capture'
      AND r.integrity_version = NEW.integrity_version AND r.integrity_sha256 = NEW.integrity_sha256
      AND lab_integrity_sha256(lab_run_integrity_document(r, r.integrity_version)) = r.integrity_sha256
      AND (r.capture_id, r.capture_manifest_sha256, r.capture_evidence_sha256, r.capture_controller_sha256)
        = (NEW.capture_id, NEW.capture_manifest_sha256, NEW.capture_evidence_sha256, NEW.capture_controller_sha256)
  ) THEN
    RAISE EXCEPTION 'A coverage assessment needs a finished Daily run whose record matches its integrity fingerprint, and must name that fingerprint and the run''s pinned capture files';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verified_coverage_assessment BEFORE INSERT ON lab_coverage_assessments
  FOR EACH ROW EXECUTE FUNCTION check_coverage_assessment();

-- Saved assessments never change and are removed only with their whole run.
CREATE TRIGGER immutable_coverage_assessment BEFORE UPDATE OR DELETE ON lab_coverage_assessments
  FOR EACH ROW EXECUTE FUNCTION protect_run_records('Saved coverage assessments');
CREATE TRIGGER immutable_coverage_assessment_truncate AFTER TRUNCATE ON lab_coverage_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION protect_run_records('Saved coverage assessments');

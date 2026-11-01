-- Saved investigation events are append-only, and a run that finishes carries a
-- SHA-256 fingerprint of what it investigated, how it ended, and its complete
-- ordered events. PostgreSQL builds one versioned jsonb document for both
-- sealing and verification, so JavaScript key order never matters. These rules
-- hold for ordinary application and database writes. They do not stop an
-- administrator who deliberately disables the triggers; verification then
-- reports a mismatch instead.

ALTER TABLE lab_investigation_runs
  ADD COLUMN integrity_version integer CHECK (integrity_version > 0),
  ADD COLUMN integrity_sha256 text CHECK (integrity_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN integrity_event_count integer CHECK (integrity_event_count >= 0),
  ADD COLUMN integrity_created_at timestamptz,
  -- finalization: saved in the same commit as the run's final status.
  -- legacy_snapshot: saved by this migration for a run that had already
  -- finished. It protects the record from then on; it does not establish
  -- what happened to the record before.
  ADD COLUMN integrity_origin text CHECK (integrity_origin IN ('finalization', 'legacy_snapshot'));

-- Version 1 covers the run's ID and source identity, its final status and
-- answer, and every event's ID and complete payload in saved order. A
-- different document is a new version; a saved fingerprint is always verified
-- with the version it was created with.
CREATE FUNCTION lab_run_integrity_document(run lab_investigation_runs, fingerprint_version integer) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE fingerprint_version WHEN 1 THEN jsonb_build_object(
    'version', 1,
    'run', jsonb_build_object(
      'id', run.id, 'source', run.source,
      'trialId', run.trial_id, 'deploymentId', run.deployment_id, 'caseId', run.case_id, 'caseVersion', run.case_version,
      'captureId', run.capture_id, 'captureManifestSha256', run.capture_manifest_sha256,
      'captureEvidenceSha256', run.capture_evidence_sha256, 'captureControllerSha256', run.capture_controller_sha256),
    'status', run.status,
    'answer', run.answer,
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', e.event_id, 'payload', e.payload) ORDER BY e.sequence)
      FROM lab_investigation_events e WHERE e.run_id = run.id), '[]'::jsonb))
  END
$$;

-- jsonb text has one form for equal values: keys sorted, whitespace fixed.
CREATE FUNCTION lab_integrity_sha256(document jsonb) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT encode(sha256(convert_to(document::text, 'UTF8')), 'hex') $$;

-- Runs that already finished are sealed as they are now.
UPDATE lab_investigation_runs r SET
  integrity_version = 1,
  integrity_sha256 = lab_integrity_sha256(lab_run_integrity_document(r, 1)),
  integrity_event_count = (SELECT count(*) FROM lab_investigation_events e WHERE e.run_id = r.id),
  integrity_created_at = clock_timestamp(),
  integrity_origin = 'legacy_snapshot'
WHERE status <> 'running';

ALTER TABLE lab_investigation_runs ADD CONSTRAINT run_integrity_fingerprint CHECK (
  (status = 'running' AND integrity_version IS NULL AND integrity_sha256 IS NULL AND integrity_event_count IS NULL
    AND integrity_created_at IS NULL AND integrity_origin IS NULL)
  OR (status <> 'running' AND integrity_version IS NOT NULL AND integrity_sha256 IS NOT NULL
    AND integrity_event_count IS NOT NULL AND integrity_created_at IS NOT NULL AND integrity_origin IS NOT NULL)
);

-- A run is sealed in the statement that gives it a final status, including
-- worker recovery marking interrupted work failed, and never changes again.
-- The row lock this UPDATE holds is the one every event insert takes, so the
-- events read here are exactly the run's final events. A run inserted already
-- finished cannot have events and is sealed with none.
CREATE FUNCTION seal_finished_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'running' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Finished investigation runs are immutable: status, answer, usage, and integrity fingerprint never change';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'running' THEN
    RETURN NEW; -- run_integrity_fingerprint keeps a running run unsealed.
  END IF;
  -- At READ COMMITTED, the query below sees every event committed before this
  -- row lock was acquired. An older REPEATABLE READ or SERIALIZABLE snapshot
  -- could omit one, so those transactions cannot finish a run.
  IF TG_OP = 'UPDATE' AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Investigation runs are finished at READ COMMITTED isolation, so their fingerprint includes every committed event';
  END IF;
  document := lab_run_integrity_document(NEW, 1);
  NEW.integrity_version := 1;
  NEW.integrity_sha256 := lab_integrity_sha256(document);
  NEW.integrity_event_count := jsonb_array_length(document -> 'events');
  NEW.integrity_created_at := clock_timestamp();
  NEW.integrity_origin := 'finalization';
  RETURN NEW;
END;
$$;
-- Named to fire after the 006 and 008 triggers, so it seals the final row.
CREATE TRIGGER seal_finished_run BEFORE INSERT OR UPDATE ON lab_investigation_runs
  FOR EACH ROW EXECUTE FUNCTION seal_finished_run();

-- A new event takes the same row lock as finishing its run: it either commits
-- first and is part of the final fingerprint, or waits and is refused. It is
-- appended after every saved event of the run, never placed between them.
CREATE FUNCTION append_investigation_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  SELECT status INTO run_status FROM lab_investigation_runs WHERE id = NEW.run_id FOR UPDATE;
  IF FOUND AND run_status <> 'running' THEN
    RAISE EXCEPTION 'Investigation run % is already finished; its saved events are sealed', NEW.run_id;
  END IF;
  IF EXISTS (SELECT 1 FROM lab_investigation_events WHERE run_id = NEW.run_id AND sequence >= NEW.sequence) THEN
    RAISE EXCEPTION 'Investigation events are appended after the run''s saved events';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER append_only_event_insert BEFORE INSERT ON lab_investigation_events
  FOR EACH ROW EXECUTE FUNCTION append_investigation_event();

-- Rows that belong to one run are never changed and are removed only with the
-- whole run: a foreign key cascade from deleting the run, or its trial, runs
-- after the run row is gone, and an AFTER TRUNCATE trigger sees the runs table
-- emptied by the same statement. TG_ARGV[0] names the rows in the message.
CREATE FUNCTION protect_run_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% are immutable', TG_ARGV[0];
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM lab_investigation_runs) THEN
      RAISE EXCEPTION '% are deleted only with their whole run', TG_ARGV[0];
    END IF;
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM lab_investigation_runs WHERE id = OLD.run_id) THEN
    RAISE EXCEPTION '% are deleted only with their whole run', TG_ARGV[0];
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER append_only_event_change BEFORE UPDATE OR DELETE ON lab_investigation_events
  FOR EACH ROW EXECUTE FUNCTION protect_run_records('Saved investigation events');
CREATE TRIGGER append_only_event_truncate AFTER TRUNCATE ON lab_investigation_events
  FOR EACH STATEMENT EXECUTE FUNCTION protect_run_records('Saved investigation events');

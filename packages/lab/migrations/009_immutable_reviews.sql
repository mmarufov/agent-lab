-- A review attempt's snapshot (which run, the reviewer configuration and prompt
-- hash, the exact input, and the evidence check) never changes after it is
-- saved. While the attempt runs, its response metadata may be recorded once and
-- it may finish once: completed, failed, or cancelled, including the failed
-- status worker recovery gives an interrupted attempt. A finished attempt never
-- changes. Existing rows are not rewritten.
CREATE FUNCTION preserve_review_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.run_id, NEW.configuration, NEW.prompt_sha256, NEW.input, NEW.evidence_check, NEW.started_at)
    IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.configuration, OLD.prompt_sha256, OLD.input, OLD.evidence_check, OLD.started_at)
  THEN
    RAISE EXCEPTION 'Review inputs, configurations, and evidence-check snapshots are immutable';
  END IF;
  IF OLD.status <> 'running'
    AND (NEW.status, NEW.finished_at, NEW.observation, NEW.review, NEW.error)
      IS DISTINCT FROM (OLD.status, OLD.finished_at, OLD.observation, OLD.review, OLD.error)
  THEN
    RAISE EXCEPTION 'Finished review attempts are immutable';
  END IF;
  IF OLD.observation IS NOT NULL AND NEW.observation IS DISTINCT FROM OLD.observation THEN
    RAISE EXCEPTION 'A review''s response metadata is recorded once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_review_attempt BEFORE UPDATE ON lab_investigation_reviews
  FOR EACH ROW EXECUTE FUNCTION preserve_review_attempt();

-- Evidence coverage of a finished Daily run becomes a local operation of its
-- own, kind 'coverage'. It makes no model request and belongs to its run.
--
-- When a browser-started Daily investigation completes, the transaction that
-- finishes its job also queues one coverage job, naming that job in
-- scheduled_by. The one-active-job index then never sees a moment without an
-- active operation for the run, and the unique column refuses a second
-- automatic coverage job for the same investigation. Coverage jobs a person
-- requests later leave scheduled_by empty. Existing jobs are not rewritten.
ALTER TABLE lab_execution_jobs DROP CONSTRAINT lab_execution_jobs_kind_check;
ALTER TABLE lab_execution_jobs
  ADD CONSTRAINT lab_execution_jobs_kind_check CHECK (kind IN ('investigate', 'review', 'coverage')),
  ADD COLUMN scheduled_by uuid UNIQUE REFERENCES lab_execution_jobs(id) ON DELETE CASCADE,
  ADD CONSTRAINT coverage_job_run CHECK (kind <> 'coverage' OR (run_id IS NOT NULL AND review_id IS NULL)),
  ADD CONSTRAINT scheduled_job_kind CHECK (scheduled_by IS NULL OR kind = 'coverage');

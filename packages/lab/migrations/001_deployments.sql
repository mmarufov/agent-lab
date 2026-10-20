CREATE TABLE lab_trials (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  current_deployment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0)
);

CREATE TABLE lab_deployments (
  trial_id uuid NOT NULL REFERENCES lab_trials(id) ON DELETE CASCADE,
  id text NOT NULL,
  healthy boolean NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  PRIMARY KEY (trial_id, id),
  UNIQUE (trial_id, sequence)
);

ALTER TABLE lab_trials ADD CONSTRAINT current_deployment_belongs_to_trial
  FOREIGN KEY (id, current_deployment_id)
  REFERENCES lab_deployments(trial_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- This table records committed effects. Rejected requests create no effect.
CREATE TABLE lab_actions (
  trial_id uuid NOT NULL REFERENCES lab_trials(id) ON DELETE CASCADE,
  actor text NOT NULL CHECK (actor IN ('agent', 'controller')),
  kind text NOT NULL CHECK (kind IN ('rollback', 'promote')),
  from_deployment_id text NOT NULL,
  to_deployment_id text NOT NULL,
  revision_before integer NOT NULL CHECK (revision_before >= 0),
  revision_after integer NOT NULL CHECK (revision_after = revision_before + 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (trial_id, revision_after),
  FOREIGN KEY (trial_id, from_deployment_id) REFERENCES lab_deployments(trial_id, id),
  FOREIGN KEY (trial_id, to_deployment_id) REFERENCES lab_deployments(trial_id, id)
);

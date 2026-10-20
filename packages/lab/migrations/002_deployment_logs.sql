CREATE TABLE lab_deployment_logs (
  trial_id uuid NOT NULL,
  id text NOT NULL CHECK (length(id) > 0),
  deployment_id text NOT NULL,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message text NOT NULL CHECK (length(message) > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  PRIMARY KEY (trial_id, id),
  UNIQUE (trial_id, deployment_id, sequence),
  FOREIGN KEY (trial_id, deployment_id)
    REFERENCES lab_deployments(trial_id, id) ON DELETE CASCADE
);

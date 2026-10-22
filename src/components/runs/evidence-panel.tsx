"use client";
import { FileText, Check } from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
import { Empty } from "./display";
export function EvidencePanel({
  run,
  selected,
  selectedEvent,
  onCitation,
  onViewTrace,
}: {
  run: RunView;
  selected: string | null;
  selectedEvent: string | null;
  onCitation: (id: string, eventId?: string) => void;
  onViewTrace: () => void;
}) {
  return (
    <div className="evidence-panel">
      <div className="evidence-header">
        <h2>
          <FileText size={14} />
          Received evidence
          <span className="evidence-count">
            {run.evidence.length.toString().padStart(2, "0")}
          </span>
        </h2>
        <p>Logs returned to this investigation.</p>
      </div>
      {run.evidence.length === 0 ? (
        <Empty title="No received logs">
          {run.status === "running"
            ? "Tool results will appear here as they are recorded."
            : "No log records were retrieved. This does not establish that the deployment is healthy."}
        </Empty>
      ) : (
        run.evidence.map((item, index) => (
          <div
            key={`${item.resultEventId}:${item.log.id}:${index}`}
            className="evidence-log"
            data-selected={
              selected === item.log.id &&
              (!selectedEvent || selectedEvent === item.resultEventId)
            }
          >
            <div className="log-meta">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <button
                onClick={() => onCitation(item.log.id, item.resultEventId)}
                aria-label={`Inspect ${item.log.id}`}
              >
                {item.log.id}
              </button>
              <span className="log-level" data-level={item.log.level}>
                {item.log.level}
              </span>
            </div>
            <p>{item.log.message}</p>
            {selected === item.log.id &&
              (!selectedEvent || selectedEvent === item.resultEventId) && (
                <div className="receipt">
                  <dl>
                    <dt>Tool</dt>
                    <dd>get_logs</dd>
                    <dt>Input</dt>
                    <dd>deploymentId: {item.log.deploymentId}</dd>
                    <dt>Call ID</dt>
                    <dd>{item.callId}</dd>
                    <dt>Result ID</dt>
                    <dd>{item.resultEventId}</dd>
                  </dl>
                  <button className="text-link mt-3" onClick={onViewTrace}>
                    View in activity
                  </button>
                </div>
              )}
          </div>
        ))
      )}
      {selected && !run.evidence.some((item) => item.log.id === selected) && (
        <p className="notice notice-error">
          {selected} was not found in the received evidence.
        </p>
      )}
      {run.ambiguousEvidenceIds.length > 0 && (
        <p className="notice notice-error">
          Conflicting content for {run.ambiguousEvidenceIds.join(", ")}.
        </p>
      )}
      <div className="evidence-bottom">
        <Check size={11} />
        From recorded tool results · simulated data
      </div>
    </div>
  );
}

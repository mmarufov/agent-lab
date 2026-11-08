"use client";
import { useState } from "react";
import { FileText, Check } from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
import { Empty } from "./display";
import { RecordDetails, RecordLine } from "./records";

const PAGE = 25;

/** Every received record once, with the tool calls that returned it. The selected one shows in full. */
export function EvidencePanel({
  run,
  selected,
  selectedEvent,
  onSelect,
  onViewTrace,
}: {
  run: RunView;
  selected: string | null;
  selectedEvent: string | null;
  onSelect: (id: string, resultEventId: string) => void;
  onViewTrace: (resultEventId: string) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const isSelected = (entry: RunView["evidence"][number]) =>
    entry.id === selected &&
    (!selectedEvent || entry.receipts.some((receipt) => receipt.resultEventId === selectedEvent));
  const selectedIndex = run.evidence.findIndex(isSelected);
  const visible = run.evidence.slice(0, Math.max(shown, selectedIndex + 1));
  const remaining = run.evidence.length - visible.length;
  const daily = run.source === "daily_capture";
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
        <p>{daily ? "Records the investigator's tool calls returned, once each." : "Logs returned to this investigation."}</p>
      </div>
      {run.evidence.length === 0 ? (
        <Empty title={daily ? "No received records" : "No received logs"}>
          {run.status === "running"
            ? "Tool results will appear here as they are recorded."
            : daily
              ? "No records were retrieved. This does not establish that Daily was healthy."
              : "No log records were retrieved. This does not establish that the deployment is healthy."}
        </Empty>
      ) : (
        visible.map((entry) => {
          const record = run.records[entry.key];
          const open = isSelected(entry);
          return (
            <div
              key={entry.key}
              className="evidence-log"
              data-selected={open}
              data-record-type={record.type}
            >
              <RecordLine
                record={record}
                id={
                  <button
                    className="record-id"
                    onClick={() => onSelect(entry.id, entry.receipts[0].resultEventId)}
                    aria-label={`Inspect ${entry.id}`}
                    aria-pressed={open}
                  >
                    {entry.id}
                  </button>
                }
              />
              {entry.receipts.length > 1 && !open && (
                <p className="record-facts">Returned by {entry.receipts.length} tool calls</p>
              )}
              {open && <RecordDetails record={record} receipts={entry.receipts} onViewTrace={onViewTrace} />}
            </div>
          );
        })
      )}
      {remaining > 0 && (
        <button className="show-more evidence-more" onClick={() => setShown(visible.length + PAGE)}>
          Show {Math.min(PAGE, remaining)} more of {remaining}
        </button>
      )}
      {selected && selectedIndex < 0 && (
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
        {daily ? `From recorded tool results · capture ${run.captureId}` : "From recorded tool results · simulated data"}
      </div>
    </div>
  );
}

"use client";
import { useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Status } from "./display";

type Row = { key: string; label: string; status: "pass" | "fail" | "not_evaluated"; reason: string };

/** Whether the saved record still matches the fingerprint sealed when it finished. */
function integrityRow({ integrity }: RunView): Row {
  const label = "Saved record matches its fingerprint";
  const { status, fingerprint, currentEventCount } = integrity;
  if (status === "not_finished") return { key: "integrity", label, status: "not_evaluated", reason: "The record is sealed with a fingerprint when the run finishes." };
  if (!fingerprint) return { key: "integrity", label, status: "fail", reason: "The run finished without a fingerprint. New reviews and coverage checks are refused." };
  const sealed = fingerprint.origin === "finalization"
    ? `Fingerprint v${fingerprint.version} of ${fingerprint.eventCount} event(s), sealed when the run finished.`
    : `Sealed by migration 010 for a run that had already finished. It protects the record from then on, not its earlier history.`;
  return status === "verified"
    ? { key: "integrity", label, status: "pass", reason: `${sealed} SHA-256 ${fingerprint.sha256}.` }
    : { key: "integrity", label, status: "fail", reason: `The saved events or final fields changed after sealing: the record now has ${currentEventCount} event(s) and no longer matches SHA-256 ${fingerprint.sha256}.` };
}

export function EvidenceChecks({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const daily = run.source === "daily_capture";
  const labels = {
    execution: "Investigation completed",
    answer: "Saved answer matches trace",
    toolTrace: "Tool requests and results match",
    retrieval: daily ? "Recorded evidence received" : "Deployment logs received",
    citations: daily ? "Citations refer to received records" : "Citations refer to received logs",
  };
  const rows: Row[] = [
    integrityRow(run),
    ...(Object.keys(labels) as (keyof typeof labels)[]).map((key) => ({ key, label: labels[key], ...run.checks[key] })),
    ...(daily && !run.reportReproduced
      ? [{ key: "reproduced", label: "Saved events reproduce the frozen report", status: "fail" as const, reason: "The saved events no longer produce the evidence report frozen when the investigation finished." }]
      : []),
  ];
  const failures = rows.filter((row) => row.status === "fail");
  const row = (value: Row) => (
    <div className="check-row" key={value.key}>
      <div>
        <span>{value.label}</span>
        <p>{value.reason}</p>
      </div>
      <Status
        value={value.status}
        label={
          value.status === "pass"
            ? "Passed"
            : value.status === "fail"
              ? "Failed"
              : "Not assessed"
        }
      />
    </div>
  );
  const heading = (
    <>
      <ShieldCheck size={16} aria-hidden="true" />
      <span className="checks-title">
        Evidence checks<small>Integrity, trace, and citations · TypeScript</small>
      </span>
      <span className="checks-count">
        {run.status === "running"
          ? "Waiting for the saved answer"
          : failures.length
            ? `${failures.length} failed`
            : `${rows.filter((value) => value.status === "pass").length} / ${rows.length} passed`}
      </span>
    </>
  );
  return (
    <section
      id="checks"
      className="result-section workspace-checks"
      aria-label="Evidence checks"
      tabIndex={-1}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        {run.status === "running" ? (
          <div className="checks-trigger">{heading}</div>
        ) : (
          <CollapsibleTrigger className="checks-trigger">
            {heading}
            <ChevronDown
              size={14}
              className={open ? "rotate-180" : undefined}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        )}
        {run.status !== "running" && failures.map(row)}
        <CollapsibleContent>
          {rows.filter((value) => value.status !== "fail").map(row)}
          <p className="footnote">
            {run.evaluatorVersion}
            {daily ? " · frozen when the investigation finished" : ""} · Checks where cited records came from, not whether
            they support the diagnosis. The model review assesses that separately.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

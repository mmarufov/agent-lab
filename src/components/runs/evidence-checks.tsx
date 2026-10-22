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
const labels = {
  execution: "Investigation completed",
  answer: "Saved answer matches trace",
  toolTrace: "Tool requests and results match",
  retrieval: "Deployment logs received",
  citations: "Citations refer to received logs",
};
export function EvidenceChecks({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(run.checks);
  const failures = entries.filter(([, check]) => check.status === "fail");
  const row = ([key, check]: (typeof entries)[number]) => (
    <div className="check-row" key={key}>
      <div>
        <span>{labels[key as keyof typeof labels]}</span>
        <p>{check.reason}</p>
      </div>
      <Status
        value={check.status}
        label={
          check.status === "pass"
            ? "Passed"
            : check.status === "fail"
              ? "Failed"
              : "Not assessed"
        }
      />
    </div>
  );
  const heading = (
    <>
      <ShieldCheck size={16} />
      <span className="checks-title">
        Evidence checks<small>TypeScript</small>
      </span>
      <span className="checks-count">
        {run.status === "running"
          ? "Waiting for the saved answer"
          : failures.length
            ? `${failures.length} failed`
            : `${entries.filter(([, check]) => check.status === "pass").length} / ${entries.length} passed`}
      </span>
    </>
  );
  return (
    <section
      id="checks"
      className="workspace-checks"
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
            />
          </CollapsibleTrigger>
        )}
        {run.status !== "running" && failures.map(row)}
        <CollapsibleContent>
          {entries.filter(([, check]) => check.status !== "fail").map(row)}
          <p className="footnote">
            {run.evaluatorVersion} · Checks recorded evidence and references.
            The model review assesses whether that evidence supports the
            diagnosis.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

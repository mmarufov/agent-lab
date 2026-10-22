"use client";
import { useState } from "react";
import { ChevronDown, Target, Link2 } from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Status } from "./display";

export function OutcomeChecks({ run, onCitation, selected }: { run: RunView; onCitation: (id: string) => void; selected: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const report = run.outcome;
  const assessed = report.status !== "not_evaluated";
  const heading = <><Target size={16} /><span className="checks-title">Outcome checks<small>{run.caseName ? `${run.caseName} · version ${run.caseVersion}` : "Saved case assessment"}</small></span><span className="checks-count"><Status value={report.status} label={report.status === "pass" ? "Passed" : report.status === "fail" ? "Failed" : "Not assessed"} /></span></>;
  return (
    <section className="workspace-checks outcome-checks" aria-label="Outcome checks">
      <Collapsible open={expanded || report.status === "fail"} onOpenChange={setExpanded}>
        {report.status === "pass" ? <CollapsibleTrigger className="checks-trigger">{heading}<ChevronDown size={14} /></CollapsibleTrigger> : <div className="checks-trigger">{heading}</div>}
        {!assessed && <p className="footnote">{run.status === "running" ? "Waiting for the completed investigation." : report.reasons.join(" ")}</p>}
        <CollapsibleContent>
          {report.expected && <table className="outcome-table">
            <caption className="sr-only">Expected versus observed outcome</caption>
            <thead><tr><th scope="col">Claim</th><th scope="col">Expected</th><th scope="col">Observed</th></tr></thead>
            <tbody>{(["state", "cause", "configurationKey"] as const).map((key) => <tr key={key}><th scope="row">{key === "configurationKey" ? "Configuration" : key === "state" ? "State" : "Cause"}</th><td>{report.expected![key] ?? "None"}</td><td>{report.observed ? report.observed[key] ?? "None" : "Unavailable"}</td></tr>)}</tbody>
          </table>}
          <ul className="outcome-reasons">{report.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {report.supportingEvidence.length > 0 && <div className="citation-group" aria-label="Decisive evidence">{report.supportingEvidence.map(({ id }) => <button className="citation" key={id} aria-label={id} title={id} aria-pressed={selected === id} onClick={() => onCitation(id)}><Link2 size={10} />{id.split(":").at(-1)}</button>)}</div>}
          <p className="footnote">{report.evaluatorVersion} · Checks structured claims against the saved case and retrieved evidence. AI review assesses the explanation separately.</p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

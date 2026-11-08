"use client";
import { useState, type ReactNode } from "react";
import { ChevronDown, Link2, LoaderCircle, Radar } from "lucide-react";
import type { CoverageAssessmentView, DailyRunView } from "@agent-lab/lab/web";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Status, timestamp } from "./display";

type Fact = CoverageAssessmentView["facts"][number];

const names: Record<string, string> = { server_errors: "Server errors", no_response: "No response", recovery: "Recovery" };
const statusLabel = { covered: "Covered", missed: "Missed", not_assessed: "Not assessed" } as const;
// The rows a Daily run always shows, before any assessment is saved.
const pending = ["server_errors", "no_response", "recovery"];

/**
 * Automatic evidence coverage of a Daily run: for each availability fact in
 * the full recording, whether the investigator retrieved a record that
 * establishes it. Records it never retrieved are labeled, never shown as received.
 */
export function CoverageSection({
  run,
  selected,
  onCitation,
  onInspectRecording,
  action,
}: {
  run: DailyRunView;
  selected: string | null;
  /** Select a received record in the activity. */
  onCitation: (id: string) => void;
  /** Show a record from the recording that the investigator never received. */
  onInspectRecording: (id: string) => void;
  /** Check or Retry coverage, when the run offers it. */
  action: ReactNode;
}) {
  const { coverage } = run;
  const assessment = coverage.assessment;
  const received = new Set(run.evidence.map((entry) => entry.id));
  const cite = (id: string) => (
    <button
      key={id}
      className="citation"
      aria-label={id}
      title={id}
      aria-pressed={selected === id}
      onClick={() => onCitation(id)}
      disabled={!received.has(id)}
    >
      <Link2 size={10} />
      {id}
    </button>
  );
  const notRetrieved = (id: string) => (
    <button
      key={id}
      className="citation citation-recording"
      aria-label={`${id} · in recording; not retrieved`}
      title="In recording; not retrieved"
      onClick={() => onInspectRecording(id)}
    >
      {id}
    </button>
  );
  return (
    <section id="coverage" className="result-section coverage-section" aria-label="Evidence coverage" tabIndex={-1}>
      <h2 className="section-label">
        Evidence coverage <span>Automatic · no model request</span>
      </h2>
      <p className="section-lede">
        Whether the investigator retrieved records that establish each availability fact in the full recording before it
        answered. It checks retrieval only, not whether the diagnosis is right.
      </p>
      {coverage.state === "checking" && (
        <p className="section-progress" role="status">
          <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />
          Checking coverage against the full recording…
        </p>
      )}
      {coverage.state === "waiting" && (
        <p className="footnote">Checked automatically after the answer is saved. It reads the recording and makes no model request.</p>
      )}
      {coverage.state === "not_applicable" && (
        <p className="footnote">The investigation did not complete, so its coverage is not assessed.</p>
      )}
      {coverage.state === "check_failed" && (
        <Alert variant="destructive" className="section-alert">
          <Radar />
          <AlertTitle>Coverage could not be checked</AlertTitle>
          <AlertDescription>
            <p>{coverage.error}</p>
            <p>The saved answer is unchanged. Retrying reads the recording again and makes no model request.</p>
          </AlertDescription>
        </Alert>
      )}
      {coverage.state === "not_checked" && (
        <p className="footnote">
          No coverage assessment is saved for this investigation, for example one started from the terminal. Checking reads
          the recording and makes no model request.
        </p>
      )}
      {(coverage.action || coverage.blocked) && (
        <div className="section-actions">
          {action}
          {coverage.blocked && <p className="footnote">{coverage.blocked}</p>}
        </div>
      )}
      {assessment && !assessment.integrity.matchesCurrentRecord && (
        <Alert variant="destructive" className="section-alert">
          <AlertTitle>Saved for an earlier state of this record</AlertTitle>
          <AlertDescription>
            <p>
              This assessment was saved while the record matched fingerprint {assessment.integrity.sha256.slice(0, 12)}. The
              record no longer verifies, so the result describes the record as it was then, not now.
            </p>
          </AlertDescription>
        </Alert>
      )}
      <div className="coverage-rows">
        {assessment
          ? assessment.facts.map((fact) => (
              <CoverageRow
                key={fact.id}
                name={names[fact.id] ?? fact.label}
                fact={fact}
                counted={assessment.retrieved.counted}
                cite={cite}
                notRetrieved={notRetrieved}
              />
            ))
          : pending.map((id) => (
              <CoverageRow key={id} name={names[id]} fact={null} counted={false} cite={cite} notRetrieved={notRetrieved} />
            ))}
      </div>
      {assessment && (
        <>
          <p className="coverage-result">
            <Status value={assessment.result} label={`Result: ${statusLabel[assessment.result].toLowerCase()}`} />
            <span>{assessment.reason}</span>
          </p>
          <details className="run-metadata">
            <summary>
              Assessment details <span>{assessment.profileVersion}</span>
            </summary>
            <dl>
              <dt>Recording</dt>
              <dd>
                {assessment.scope.feedObservations} authenticated GET /feed request(s): {assessment.scope.serverErrors} server
                error(s), {assessment.scope.noResponses} without a response, {assessment.scope.readyResponses} ready,{" "}
                {assessment.scope.otherResponses} other
              </dd>
              <dt>Retrieved</dt>
              <dd>
                {assessment.retrieved.counted
                  ? `${assessment.retrieved.records} distinct record(s) before the answer, ${assessment.retrieved.httpObservations} of them HTTP observations, each identical to the recording`
                  : "Not counted; this investigation cannot be assessed"}
              </dd>
              <dt>Answer</dt>
              <dd>{assessment.answerInterpretation.reason}</dd>
              <dt>Versions</dt>
              <dd>
                {assessment.profileVersion} · {assessment.evaluatorVersion}
              </dd>
              <dt>Assessed</dt>
              <dd>{timestamp(assessment.assessedAt)} UTC</dd>
              <dt>Assessment ID</dt>
              <dd>{assessment.id}</dd>
            </dl>
          </details>
        </>
      )}
    </section>
  );
}

function CoverageRow({
  name,
  fact,
  counted,
  cite,
  notRetrieved,
}: {
  name: string;
  fact: Fact | null;
  counted: boolean;
  cite: (id: string) => ReactNode;
  notRetrieved: (id: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = fact?.status ?? "not_assessed";
  const label = <Status value={status} label={statusLabel[status]} />;
  const title = (
    <div className="coverage-fact">
      <span>{name}</span>
      <p>{fact && status === "not_assessed" ? fact.reason : (fact?.statement ?? "Not assessed yet")}</p>
    </div>
  );
  // Successful details start collapsed; a missed fact shows what is missing.
  if (fact && status === "covered")
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="coverage-row" data-status={status}>
        <CollapsibleTrigger className="coverage-row-trigger" aria-label={`${name}: covered`}>
          {title}
          {label}
          <ChevronDown size={14} className={open ? "rotate-180" : undefined} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {fact.requirements.map((requirement) => (
            <div key={requirement.id} className="coverage-requirement">
              <p>Needs {requirement.description}.</p>
              <div className="citation-group">
                <span className="citation-label">Retrieved</span>
                {requirement.matchedIds.map(cite)}
              </div>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  return (
    <div className="coverage-row" data-status={status}>
      <div className="coverage-row-trigger">
        {title}
        {label}
      </div>
      {fact && status === "missed" &&
        fact.requirements.map((requirement) => (
          <div key={requirement.id} className="coverage-requirement">
            <p>Needs {requirement.description}.</p>
            {requirement.matchedIds.length ? (
              <div className="citation-group">
                <span className="citation-label">Retrieved</span>
                {requirement.matchedIds.map(cite)}
              </div>
            ) : (
              counted && (
                <div className="citation-group">
                  <span className="citation-label">In recording; not retrieved</span>
                  {requirement.anyOf.map(notRetrieved)}
                </div>
              )
            )}
          </div>
        ))}
    </div>
  );
}

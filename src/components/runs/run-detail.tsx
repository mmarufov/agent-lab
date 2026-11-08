"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ChevronRight,
  Link2,
  ShieldCheck,
  PanelRightOpen,
  LoaderCircle,
  Square,
  Radar,
  ShieldAlert,
  AudioWaveform,
} from "lucide-react";
import type { ActivityItem, RunView } from "@agent-lab/lab/web";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Status, Empty, money, duration, recordedAt, timestamp, tokens } from "./display";
import { useRunController } from "./use-run-controller";
import { EvidencePanel } from "./evidence-panel";
import { ActivityPanel, ActivitySteps, matchesEvent, type RecordSelection } from "./activity-panel";
import { OutcomeChecks } from "./outcome-checks";
import { EvidenceChecks } from "./evidence-checks";
import { CoverageSection } from "./coverage-section";
import { RecordDetails } from "./records";
import { ReviewView } from "./review-view";
import { useScrollPosition } from "./use-scroll-position";

export function RunDetail({
  initial,
  executionEnabled,
}: {
  initial: RunView;
  executionEnabled: boolean;
}) {
  const controller = useRunController(initial);
  const { run, operation } = controller;
  const [drawer, setDrawer] = useState(false);
  // A recording record shown in the Sheet that the investigator never received.
  const [recording, setRecording] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showActivity, setActivityChoice] = useState(true);
  const router = useRouter(),
    search = useSearchParams();
  const focusBeforeDrawer = useRef<HTMLElement | null>(null);
  const [activityLatestDismissed, setActivityLatestDismissed] = useState(false);
  const {
    scroll: resultsScroll,
    content: resultsContent,
    inspect: inspectResult,
    handlers: resultsHandlers,
    awayFromBottom: resultsAwayFromBottom,
    jumpToLatest: jumpToLatestResults,
  } = useScrollPosition({ once: true });
  const selected = search.get("log"),
    selectedEvent = search.get("event");
  const daily = run.source === "daily_capture";
  function select(values: Record<string, string | null>) {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.push(`/runs/${run.id}?${params}`, { scroll: false });
  }
  function openSheet(recordingId: string | null = null) {
    focusBeforeDrawer.current = document.activeElement as HTMLElement;
    setRecording(recordingId);
    setDrawer(true);
  }
  function revealResult(event: string | null) {
    const activity = run.activity.find((item) => matchesEvent(item, event));
    if (activity)
      setExpanded((previous) => ({ ...previous, [activity.id]: true }));
    setActivityChoice(true);
  }
  function citation(id: string) {
    const event = run.evidence.find((item) => item.id === id)?.receipts[0]?.resultEventId ?? null;
    revealResult(event);
    select({ log: id, event, tab: null });
    if (window.matchMedia("(max-width: 1023px)").matches) openSheet();
  }
  const selection: RecordSelection = {
    records: run.records,
    selectedLog: selected,
    selectedEvent,
    onSelect: (id, event) => select({ log: id, event, tab: null }),
    onOpen: () => openSheet(),
  };
  function citations(ids: string[]) {
    return (
      <div className="citation-group">
        {ids.map((id) => (
          <button
            key={id}
            className={`citation ${run.missingEvidenceIds.includes(id) ? "citation-missing" : ""}`}
            onClick={() => citation(id)}
            aria-label={`${id}${run.missingEvidenceIds.includes(id) ? " · unavailable" : ""}`}
            title={id}
            aria-pressed={selected === id}
          >
            <Link2 size={10} />
            {id.split(":").at(-1)}
            {run.missingEvidenceIds.includes(id) && " · unavailable"}
          </button>
        ))}
      </div>
    );
  }
  function selectReview(id: string) {
    setActivityChoice(true);
    select({ review: id, tab: "review" });
    const target = document.getElementById("review");
    if (target && resultsScroll.current) {
      if (window.matchMedia("(min-width: 1024px)").matches)
        inspectResult(target, "start");
      else target.scrollIntoView({ block: "nearest" });
    }
  }
  const legacyTab = search.get("tab");
  useEffect(() => {
    if (legacyTab === "review" || legacyTab === "trace") {
      const target = document.getElementById(
        legacyTab === "trace" ? "activity" : "review",
      );
      if (!target) return;
      if (!window.matchMedia("(min-width: 1024px)").matches)
        target.scrollIntoView({ block: "nearest" });
      else if (legacyTab === "review" && resultsScroll.current)
        inspectResult(target);
    }
  }, [legacyTab, resultsScroll, inspectResult]);
  const active = Boolean(
    operation ||
    run.status === "running" ||
    run.reviews.some((review) => review.status === "running"),
  );
  const awaiting = controller.awaitingJob;
  // Shown until the queued job appears in a saved snapshot.
  const activity: ActivityItem[] =
    awaiting && !run.operations.some((job) => job.id === awaiting.id)
      ? [
          ...run.activity,
          {
            id: `${awaiting.id}:${awaiting.kind === "coverage" ? "coverage" : "requested"}`,
            operationId: awaiting.id,
            actor: awaiting.kind === "coverage" ? "checks" : "reviewer",
            kind: awaiting.kind === "coverage" ? "coverage" : "review",
            title: awaiting.kind === "coverage" ? "Coverage check requested" : "Review requested",
            detail: "Waiting for the local worker",
            status: "queued",
            at: null,
            finishedAt: null,
            durationMs: null,
            eventIds: [],
          },
        ]
      : run.activity;
  const unavailable =
    selected && !run.evidence.some((item) => item.id === selected);
  const lastOperation = run.operations.findLast((job) => job.kind === "review");
  const statusMessage =
    controller.actionError ||
    run.error ||
    (controller.connection === "reconnecting"
      ? "Connection interrupted. Showing the last saved view while reconnecting."
      : operation?.cancelRequested
        ? "Cancellation requested…"
        : operation?.kind === "review"
          ? "Review in progress. Your original answer stays available."
          : operation?.kind === "coverage"
            ? "Answer saved. Checking evidence coverage without a model…"
            : operation && run.status !== "running"
              ? "Answer saved. Finishing the local operation…"
              : active
                ? "Investigation in progress. You can leave and return later."
                : null);
  const broken = run.integrity.status === "mismatch" || run.integrity.status === "missing";
  const busy = controller.pending || Boolean(operation);
  // The saved runner state can be stale once the stream settles, so an offline
  // worker only adds a hint; admission itself answers if it is still offline.
  const offline = !run.runner.online;
  const reviewDisabled = !run.reviewEligible || !executionEnabled || busy;
  const reviewReason = !run.reviewEligible
    ? run.status === "running"
      ? "Available after the answer is saved."
      : run.reviewBlocked
    : !executionEnabled
      ? "Browser execution is disabled."
      : operation
        ? "Available when the active operation finishes."
        : offline
          ? "Start the local worker with pnpm dev:lab."
          : null;
  const reviewButton = (
    <Button
      disabled={reviewDisabled}
      onClick={() => {
        setActivityChoice(true);
        select({
          review: null,
          tab: null,
          log: null,
          event: null,
        });
        void controller.review();
      }}
    >
      {controller.pending ? (
        <LoaderCircle className="motion-safe:animate-spin" size={14} />
      ) : (
        <ShieldCheck size={14} />
      )}
      Review answer
    </Button>
  );
  const reviewAction = (className: string) => (
    <div className={`review-action-bar ${className}`}>
      {reviewButton}
      {reviewReason && <p className="footnote">{reviewReason}</p>}
    </div>
  );
  const coverageAction: ReactNode =
    daily && run.coverage.action ? (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={!executionEnabled || busy || Boolean(run.coverage.blocked)}
          onClick={() => void controller.coverage()}
        >
          <Radar size={13} />
          {run.coverage.action === "retry" ? "Retry coverage" : "Check coverage"}
        </Button>
        {!run.coverage.blocked && (!executionEnabled || offline) && (
          <p className="footnote">
            {!executionEnabled ? "Browser execution is disabled." : "Start the local worker with pnpm dev:lab."}
          </p>
        )}
      </>
    ) : null;
  const inspected = recording && daily ? run.coverage.assessment?.notRetrieved[recording] : undefined;
  return (
    <main id="main" className="run-workspace" data-activity-open={showActivity} data-source={run.source}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/runs">Investigations</Link>
        <ChevronRight size={12} />
        <span className="mono">{run.id.slice(0, 8)}</span>
      </nav>
      <header className="workspace-heading">
        <div className="detail-title">
          {daily ? (
            <span className="deployment-mark source-mark" aria-hidden="true">
              <AudioWaveform size={15} />
            </span>
          ) : (
            <span className="deployment-mark">{run.deploymentId}</span>
          )}
          <div className="detail-title-text">
            <h1>{daily ? "Daily recording" : (run.caseName ?? `Deployment ${run.deploymentId}`)}</h1>
            {daily && (
              <p className="detail-subtitle">
                {recordedAt(run.recordedAt)} <span className="mono">{run.captureId}</span>
              </p>
            )}
          </div>
          <Badge variant="outline" className="source-badge">
            {daily ? "Recorded sandbox incident" : "Simulated case"}
          </Badge>
        </div>
        <div className="actions-group workspace-header-actions">
          {statusMessage && (
            <p
              role={controller.actionError || run.error ? "alert" : "status"}
              className={`workspace-status ${controller.actionError || run.error ? "workspace-status-error" : ""}`}
              title={statusMessage}
            >
              {statusMessage}
            </p>
          )}
          {operation && (
            <Button
              variant="ghost"
              size="sm"
              disabled={controller.pending || operation.cancelRequested}
              onClick={() => void controller.cancel()}
            >
              <Square size={12} /> Cancel
            </Button>
          )}
          <Status value={run.status} />
          <Button
            variant="outline"
            className="mobile-evidence-button"
            size="icon"
            aria-label="Open received evidence"
            onClick={() => openSheet()}
          >
            <PanelRightOpen />
          </Button>
        </div>
      </header>
      <div className="workspace-layout">
        <ResizablePanelGroup
          orientation="horizontal"
          className="workspace-panels"
        >
          <ResizablePanel
            id="investigation-result"
            defaultSize={showActivity ? "65%" : "100%"}
            minSize="40%"
            className="workspace-main-panel"
          >
            <div
              className="workspace-results-scroll"
              ref={resultsScroll}
              role="region"
              aria-label="Investigation results"
              tabIndex={0}
              {...resultsHandlers}
            >
              <div ref={resultsContent} className="workspace-results-content">
                {broken && (
                  <Alert variant="destructive" className="integrity-alert">
                    <ShieldAlert />
                    <AlertTitle>This saved record no longer matches its integrity fingerprint</AlertTitle>
                    <AlertDescription>
                      <p>
                        {run.integrity.status === "missing"
                          ? "The run finished without a fingerprint."
                          : "Its events or final fields changed after it was sealed."}{" "}
                        New reviews and coverage checks are disabled. Assessments saved earlier describe the record as it
                        was then.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}
                <section
                  className="workspace-task"
                  aria-label="Investigation task"
                >
                  <h2 className="section-label">Task</h2>
                  <p>{run.task}</p>
                  {daily && (
                    <p className="task-source">
                      Eve read this saved local sandbox recording through two read-only tools. Opening it changes nothing
                      in the recording or the sandbox.
                    </p>
                  )}
                </section>
                {!showActivity && (
                  <div className="activity-summary">
                    <span>
                      {active
                        ? "Investigation activity is running"
                        : `${run.activity.length} recorded steps`}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setActivityChoice(true)}
                    >
                      {active ? "Show progress" : "View activity"}
                      <ChevronRight size={13} />
                    </Button>
                  </div>
                )}
                <section
                  className="result-section workspace-answer"
                  aria-label="Investigator answer"
                >
                  <h2 className="section-label">
                    Diagnosis <span>Investigator · Eve</span>
                  </h2>
                  {run.answer ? (
                    <>
                      <p className="answer-text">{run.answer.diagnosis}</p>
                      {citations(run.answer.evidenceIds)}
                      {unavailable && (
                        <p className="notice notice-error">
                          {selected} was not found in the received evidence.
                        </p>
                      )}
                      {run.ambiguousEvidenceIds.length > 0 && (
                        <p className="notice notice-error">
                          Conflicting content for{" "}
                          {run.ambiguousEvidenceIds.join(", ")}.
                        </p>
                      )}
                      <div className="uncertainty">
                        <h2>What remains uncertain</h2>
                        <p>{run.answer.uncertainty}</p>
                      </div>
                    </>
                  ) : (
                    <Empty
                      title={
                        run.status === "running"
                          ? "Investigation in progress"
                          : "No completed answer"
                      }
                    >
                      Follow the recorded steps in Activity. The diagnosis appears
                      after its structured answer is validated.
                    </Empty>
                  )}
                  <details className="run-metadata">
                    <summary>
                      Run details{" "}
                      <span>{run.modelId ?? "Model not recorded"}</span>
                    </summary>
                    <dl>
                      <dt>Model</dt>
                      <dd>{run.modelId ?? "Not recorded"}</dd>
                      <dt>Duration</dt>
                      <dd>
                        {run.durationMs === null
                          ? "Not available yet"
                          : duration(run.durationMs)}
                      </dd>
                      <dt>Tokens</dt>
                      <dd>
                        {tokens(run.usage.inputTokens, run.usage.outputTokens)}
                      </dd>
                      <dt>Reported model cost</dt>
                      <dd>{money(run.usage.costUsd)}</dd>
                      <dt>Started</dt>
                      <dd>{timestamp(run.startedAt)} UTC</dd>
                      {daily && (
                        <>
                          <dt>Recording</dt>
                          <dd>{run.captureId}</dd>
                          <dt>Read access</dt>
                          <dd>
                            {run.accessRevokedAt
                              ? `Revoked ${timestamp(run.accessRevokedAt)} UTC`
                              : run.status === "running"
                                ? "Active while the investigation runs"
                                : "Not revoked; it expires within an hour of the start"}
                          </dd>
                          <dt>Answer schema</dt>
                          <dd>Version {run.answerSchemaVersion}</dd>
                        </>
                      )}
                      <dt>Run ID</dt>
                      <dd>{run.id}</dd>
                      <dt>Instructions hash</dt>
                      <dd>{run.instructionsHash}</dd>
                    </dl>
                  </details>
                </section>
                <EvidenceChecks run={run} />
                {run.source === "daily_capture" ? (
                  <CoverageSection
                    run={run}
                    selected={selected}
                    onCitation={citation}
                    onInspectRecording={(id) => openSheet(id)}
                    action={coverageAction}
                  />
                ) : (
                  <OutcomeChecks run={run} onCitation={citation} selected={selected} />
                )}
                <section
                  id="review"
                  className="result-section workspace-review"
                  aria-label="Independent review"
                  tabIndex={-1}
                >
                  <h2 className="section-label">
                    Independent assessment <span>Separate model request</span>
                  </h2>
                  <ReviewView
                    reviews={run.reviews}
                    selectedId={search.get("review")}
                    onSelectReview={selectReview}
                    citations={citations}
                    stale={broken}
                  />
                  {reviewAction("results-review-action")}
                </section>
              </div>
            </div>
            {resultsAwayFromBottom && (
              <Button
                className="follow-results"
                variant="outline"
                size="sm"
                onClick={jumpToLatestResults}
              >
                <ArrowDown size={12} /> Latest results
              </Button>
            )}
          </ResizablePanel>
          {showActivity && (
            <>
              <ResizableHandle
                withHandle
                className="workspace-resize"
                aria-label="Resize activity panel"
              />
              <ResizablePanel
                id="investigation-activity"
                defaultSize="35%"
                minSize="28%"
                className="workspace-activity-panel"
              >
                <ActivityPanel
                  latestDismissed={activityLatestDismissed}
                  onLatestDismissed={setActivityLatestDismissed}
                  items={activity}
                  selection={selection}
                  expanded={expanded}
                  onExpand={(id, open) =>
                    setExpanded((previous) => ({ ...previous, [id]: open }))
                  }
                  live={active && controller.connection === "live"}
                  waiting={run.status === "running" ? "Runs after the answer is saved" : null}
                  onClose={() => setActivityChoice(false)}
                  footer={reviewAction("activity-review-action")}
                >
                  <section
                    id="review-activity"
                    className="activity-stage workspace-review"
                    aria-label="Review activity"
                    tabIndex={-1}
                  >
                    <h3 className="activity-stage-heading">
                      Independent review <span>Separate model · on request</span>
                    </h3>
                    <p className="activity-stage-caption">
                      A separate model checks each claim against the received
                      evidence. It never reruns the investigator.
                    </p>
                    {!executionEnabled && (
                      <p className="footnote">Browser execution is disabled.</p>
                    )}
                    {lastOperation &&
                      ["failed", "cancelled"].includes(lastOperation.status) && (
                        <p role="status" className="notice">
                          Review {lastOperation.status}. The saved investigation
                          and earlier reviews remain available.
                        </p>
                      )}
                    {offline && (
                      <p className="footnote">
                        Start the local worker with pnpm dev:lab.{" "}
                        <button
                          className="text-link"
                          onClick={controller.refresh}
                        >
                          Refresh status
                        </button>
                      </p>
                    )}
                    {operation?.kind === "review" && (
                      <p className="review-progress" role="status">
                        <LoaderCircle size={14} className="motion-safe:animate-spin" />
                        {operation.cancelRequested
                          ? "Cancelling review…"
                          : "Reviewing the saved answer and evidence…"}
                      </p>
                    )}
                    <ActivitySteps
                      items={activity.filter(
                        (item) =>
                          item.actor === "reviewer" &&
                          (!item.reviewId ||
                            item.reviewId ===
                              (search.get("review") ?? run.reviews[0]?.id)),
                      )}
                      selection={selection}
                      expanded={expanded}
                      onExpand={(id, open) =>
                        setExpanded((previous) => ({ ...previous, [id]: open }))
                      }
                    />
                  </section>
                </ActivityPanel>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent
          className="evidence-drawer overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (focusBeforeDrawer.current?.isConnected)
              focusBeforeDrawer.current.focus();
            else document.getElementById("activity")?.focus();
          }}
        >
          {inspected ? (
            <>
              <SheetHeader className="mb-5">
                <SheetTitle>In recording; not retrieved</SheetTitle>
                <SheetDescription>
                  Coverage read this record from the full recording. The
                  investigator never received it, so it is not evidence the
                  investigator saw or cited, and the reviewer was never given it.
                </SheetDescription>
              </SheetHeader>
              <div className="evidence-panel recording-record">
                <div className="evidence-log" data-selected="false">
                  <RecordDetails record={{ type: "http", ...inspected }} />
                </div>
              </div>
            </>
          ) : (
            <>
              <SheetHeader className="mb-5">
                <SheetTitle>Received evidence</SheetTitle>
                <SheetDescription>
                  {daily
                    ? "Records the investigator's tool calls returned, once each, with every call that returned them."
                    : "The logs returned to this investigation."}
                </SheetDescription>
              </SheetHeader>
              <EvidencePanel
                run={run}
                selected={selected}
                selectedEvent={selectedEvent}
                onSelect={(id, event) => select({ log: id, event, tab: null })}
                onViewTrace={(event) => {
                  setDrawer(false);
                  revealResult(event);
                  select({ tab: "trace", event });
                }}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}

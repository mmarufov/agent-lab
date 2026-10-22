"use client";
import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
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
import { Status, Empty, money, duration, timestamp, tokens } from "./display";
import { useRunController } from "./use-run-controller";
import { EvidencePanel } from "./evidence-panel";
import { ActivityPanel, ActivitySteps, matchesEvent } from "./activity-panel";
import { OutcomeChecks } from "./outcome-checks";
import { EvidenceChecks } from "./evidence-checks";
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
  function select(values: Record<string, string | null>) {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.push(`/runs/${run.id}?${params}`, { scroll: false });
  }
  function openEvidence() {
    focusBeforeDrawer.current = document.activeElement as HTMLElement;
    setDrawer(true);
  }
  function citation(id: string) {
    const evidence = run.evidence.find((item) => item.log.id === id);
    const event = evidence?.resultEventId ?? null;
    const activity = run.activity.find((item) => matchesEvent(item, event));
    if (activity)
      setExpanded((previous) => ({ ...previous, [activity.id]: true }));
    setActivityChoice(true);
    select({ log: id, event, tab: null });
    if (window.matchMedia("(max-width: 1023px)").matches) openEvidence();
  }
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
  const activity =
    controller.awaitingJob &&
    !run.operations.some((job) => job.id === controller.awaitingJob?.id)
      ? [
          ...run.activity,
          {
            id: `${controller.awaitingJob.id}:requested`,
            operationId: controller.awaitingJob.id,
            actor: "reviewer" as const,
            kind: "review" as const,
            title: "Review requested",
            detail: "Waiting for the local worker",
            status: "queued" as const,
            at: null,
            finishedAt: null,
            durationMs: null,
            eventIds: [],
          },
        ]
      : run.activity;
  const unavailable =
    selected && !run.evidence.some((item) => item.log.id === selected);
  const lastOperation = run.operations.at(-1);
  const statusMessage =
    controller.actionError ||
    run.error ||
    (controller.connection === "reconnecting"
      ? "Connection interrupted. Showing the last saved view while reconnecting."
      : operation?.cancelRequested
        ? "Cancellation requested…"
        : operation?.kind === "review"
          ? "Review in progress. Your original answer stays available."
          : operation && run.status !== "running"
            ? "Answer saved. Finishing the local operation…"
            : active
              ? "Investigation in progress. You can leave and return later."
              : null);
  return (
    <main id="main" className="run-workspace" data-activity-open={showActivity}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/runs">Investigations</Link>
        <ChevronRight size={12} />
        <span className="mono">{run.id.slice(0, 8)}</span>
      </nav>
      <header className="workspace-heading">
        <div className="detail-title">
          <span className="deployment-mark">{run.deploymentId}</span>
          <h1>{run.caseName ?? `Deployment ${run.deploymentId}`}</h1>
          <span className="simulation-label">Simulated case</span>
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
            onClick={openEvidence}
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
                <section
                  className="workspace-task"
                  aria-label="Investigation task"
                >
                  <h2 className="section-label">Task</h2>
                  <p>{run.task}</p>
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
                  className="workspace-answer"
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
                      <dt>Run ID</dt>
                      <dd>{run.id}</dd>
                      <dt>Instructions hash</dt>
                      <dd>{run.instructionsHash}</dd>
                    </dl>
                  </details>
                </section>
                <EvidenceChecks run={run} />
                <OutcomeChecks run={run} onCitation={citation} selected={selected} />
                {run.reviews.length > 0 && (
                  <section
                    id="review"
                    className="workspace-review"
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
                    />
                  </section>
                )}
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
                  selectedLog={selected}
                  selectedEvent={selectedEvent}
                  expanded={expanded}
                  onExpand={(id, open) =>
                    setExpanded((previous) => ({ ...previous, [id]: open }))
                  }
                  live={active && controller.connection === "live"}
                  onClose={() => setActivityChoice(false)}
                >
                  <section
                    id="review-activity"
                    className="workspace-review"
                    aria-label="Review activity"
                    tabIndex={-1}
                  >
                    <div className="review-action">
                      <div>
                        <h2>Independent review</h2>
                        <p>
                          A separate model checks each claim against the
                          retrieved evidence.
                        </p>
                      </div>
                      <div>
                        <Button
                          disabled={
                            !run.reviewEligible ||
                            !executionEnabled ||
                            controller.pending ||
                            Boolean(operation)
                          }
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
                            <LoaderCircle className="animate-spin" size={14} />
                          ) : (
                            <ShieldCheck size={14} />
                          )}
                          Review answer
                        </Button>
                      </div>
                    </div>
                    {!executionEnabled && (
                      <p className="footnote">Browser execution is disabled.</p>
                    )}
                    {lastOperation?.kind === "review" &&
                      ["failed", "cancelled"].includes(
                        lastOperation.status,
                      ) && (
                        <p role="status" className="notice">
                          Review {lastOperation.status}. The saved investigation
                          and earlier reviews remain available.
                        </p>
                      )}
                    {!run.runner.online && (
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
                        <LoaderCircle size={14} className="animate-spin" />
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
                      selectedLog={selected}
                      selectedEvent={selectedEvent}
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
          <SheetHeader className="mb-5">
            <SheetTitle>Received evidence</SheetTitle>
            <SheetDescription>
              The logs returned to this investigation.
            </SheetDescription>
          </SheetHeader>
          <EvidencePanel
            run={run}
            selected={selected}
            selectedEvent={selectedEvent}
            onCitation={citation}
            onViewTrace={() => {
              setDrawer(false);
              select({ tab: "trace" });
            }}
          />
        </SheetContent>
      </Sheet>
    </main>
  );
}

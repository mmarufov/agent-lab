"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  Check,
  Circle,
  LoaderCircle,
  Terminal,
  X,
  Minus,
  Cpu,
  ShieldCheck,
  ListChecks,
} from "lucide-react";
import type { ActivityItem, RecordView, ToolResultView } from "@agent-lab/lab/web";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { Button } from "@/components/ui/button";
import { duration, Status } from "./display";
import { RecordLine } from "./records";
import { useScrollPosition } from "./use-scroll-position";

/** How many records one tool result shows before "Show more". */
const PAGE = 20;

export function matchesEvent(item: ActivityItem, event: string | null) {
  return Boolean(
    event &&
    (item.id === event ||
      item.eventIds.some(
        (id) => id === event || `${id}:${item.tool?.callId}` === event,
      )),
  );
}

export interface RecordSelection {
  /** Every record the run's tool results returned, by key. */
  records: Record<string, RecordView>;
  selectedLog: string | null;
  selectedEvent: string | null;
  /** Select a received record as returned by one result event. */
  onSelect: (id: string, resultEventId: string) => void;
  /** Open the selected record in the evidence Sheet. */
  onOpen: () => void;
}

export function ActivityPanel({
  items,
  selection,
  expanded,
  onExpand,
  children,
  footer,
  live,
  waiting,
  onClose,
  latestDismissed,
  onLatestDismissed,
}: {
  items: ActivityItem[];
  selection: RecordSelection;
  expanded: Record<string, boolean>;
  onExpand: (id: string, open: boolean) => void;
  /** The Independent review group, last in the timeline. */
  children: ReactNode;
  /** Kept below the timeline so the review action stays reachable in long traces. */
  footer?: ReactNode;
  live: boolean;
  /** Shown in Automated checks until the first check exists. */
  waiting: string | null;
  onClose: () => void;
  latestDismissed: boolean;
  onLatestDismissed: (value: boolean) => void;
}) {
  const { scroll, content, awayFromBottom, jumpToLatest, inspect, handlers } =
    useScrollPosition({ once: true, initialDismissed: latestDismissed, onDismiss: onLatestDismissed });
  const current = items.findLast(
    (item) => item.status === "running" || item.status === "queued",
  );
  const { selectedEvent, selectedLog } = selection;
  useEffect(() => {
    if (!selectedEvent && !selectedLog) return;
    const frame = requestAnimationFrame(() => {
      const target =
        scroll.current?.querySelector<HTMLElement>(
          ".evidence-log[data-selected=true]",
        ) ?? scroll.current?.querySelector<HTMLElement>("[data-selected=true]");
      if (target && scroll.current) {
        inspect(target);
        if (window.matchMedia("(min-width: 1024px)").matches)
          target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedEvent, selectedLog, inspect, scroll]);
  const checks = items.filter((item) => item.actor === "checks");
  return (
    <aside
      id="activity"
      className="activity-panel"
      aria-label="Investigation activity"
      tabIndex={-1}
    >
      <div className="activity-heading">
        <h2>Activity</h2>
        <div className="actions-group">
          <span className="activity-connection">
            <span className={live ? "live-dot" : "saved-dot"} />
            {live ? "Live" : "Saved"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close activity"
            onClick={onClose}
          >
            <X size={13} />
          </Button>
        </div>
      </div>
      <p className="activity-caption">Observed actions, in recorded order.</p>
      <div className="activity-scroll-frame">
        <div
          className="activity-scroll"
          ref={scroll}
          role="region"
          aria-label="Activity timeline"
          tabIndex={0}
          {...handlers}
        >
          <div ref={content} className="activity-content">
            <section aria-label="Investigator steps" className="activity-stage">
              <h3 className="activity-stage-heading">
                Investigation <span>Eve · model calls</span>
              </h3>
              <ActivitySteps
                items={items.filter((item) => item.actor === "investigator")}
                selection={selection}
                expanded={expanded}
                onExpand={onExpand}
              />
            </section>
            <section aria-label="Automated checks" className="activity-stage">
              <h3 className="activity-stage-heading">
                Automated checks <span>TypeScript · no model</span>
              </h3>
              {checks.length > 0 ? (
                <ActivitySteps
                  items={checks}
                  selection={selection}
                  expanded={expanded}
                  onExpand={onExpand}
                />
              ) : (
                waiting && (
                  <TraceLine status="pending" className="activity-waiting">
                    <TraceIcon>
                      <ListChecks />
                    </TraceIcon>
                    <TraceTitle>{waiting}</TraceTitle>
                  </TraceLine>
                )
              )}
            </section>
            {children}
          </div>
        </div>
        {/* Anchored to the timeline, above the footer and its review action. */}
        {awayFromBottom && (
          <Button
            className="follow-activity"
            variant="outline"
            size="sm"
            onClick={jumpToLatest}
          >
            <ArrowDown size={12} /> Latest activity
          </Button>
        )}
      </div>
      <div className="activity-footer" role="status">
        {current ? current.title : "All saved activity shown"}
      </div>
      {footer}
    </aside>
  );
}

export function ActivitySteps({
  items,
  selection,
  expanded,
  onExpand,
}: {
  items: ActivityItem[];
  selection: RecordSelection;
  expanded: Record<string, boolean>;
  onExpand: (id: string, open: boolean) => void;
}) {
  const current = items.findLast(
    (item) => item.status === "running" || item.status === "queued",
  );
  return (
    <Trace className="activity-trace">
      {items.map((item) => {
        const selected = matchesEvent(item, selection.selectedEvent);
        const open =
          expanded[item.id] ??
          (selected || (item.id === current?.id && item.kind === "tool"));
        const busy = item.status === "running" || item.status === "queued";
        const Icon = busy
          ? LoaderCircle
          : item.status === "failed"
            ? X
            : item.status === "cancelled" || item.status === "interrupted"
              ? Minus
              : item.kind === "tool"
                ? Terminal
                : item.kind === "model"
                  ? Cpu
                  : item.kind === "review"
                    ? ShieldCheck
                    : item.kind === "coverage" || item.kind === "checks"
                      ? ListChecks
                      : item.status === "completed"
                        ? Check
                        : Circle;
        const heading = (
          <TraceLine
            status={
              busy
                ? "running"
                : item.status === "failed" || item.status === "interrupted"
                  ? "error"
                  : undefined
            }
          >
            <TraceIcon>
              <Icon className={busy ? "motion-safe:animate-spin" : undefined} />
            </TraceIcon>
            <TraceTitle>{item.title}</TraceTitle>
          </TraceLine>
        );
        const summary = (
          <>
            {item.tool && !item.detail.startsWith("Requested") && (
              <p className="activity-detail activity-request">Requested · {item.tool.request}</p>
            )}
            <p className="activity-detail">{item.detail}</p>
            {item.error && (
              <p className="activity-error" role="note">
                {item.error}
              </p>
            )}
            <div className="activity-step-meta">
              <Status value={item.status} />
              {item.at && (
                <span className="activity-time">
                  <time dateTime={item.at}>
                    {new Date(item.at).toISOString().slice(11, 23)} UTC
                  </time>
                  {item.durationMs !== null &&
                    ` · ${duration(item.durationMs)}`}
                </span>
              )}
            </div>
          </>
        );
        return (
          <article
            key={item.id}
            className="activity-item"
            data-status={item.status}
            data-selected={selected}
            data-current={current?.id === item.id}
            data-activity-id={item.id}
            tabIndex={-1}
          >
            {item.tool ? (
              <TraceCollapsible
                open={Boolean(open)}
                onOpenChange={(value) => onExpand(item.id, value)}
              >
                <TraceCollapsibleTrigger
                  aria-label={`${item.title}: ${item.detail}`}
                >
                  {heading}
                </TraceCollapsibleTrigger>
                {summary}
                <TraceCollapsibleContent>
                  <div className="activity-inspection">
                    <div className="receipt">
                      <dl>
                        <dt>Input</dt>
                        <dd>
                          {item.tool.input
                            ? JSON.stringify(item.tool.input)
                            : "Not available"}
                        </dd>
                        <dt>Turn ID</dt>
                        <dd>{item.tool.turnId || "Not recorded"}</dd>
                        <dt>Call ID</dt>
                        <dd>{item.tool.callId || "Not recorded"}</dd>
                      </dl>
                    </div>
                    {item.tool.results.map((result) => (
                      <ToolResult
                        key={result.eventId}
                        tool={item.tool!.name}
                        result={result}
                        itemSelected={selected}
                        selection={selection}
                      />
                    ))}
                  </div>
                </TraceCollapsibleContent>
              </TraceCollapsible>
            ) : (
              <>
                {heading}
                {summary}
              </>
            )}
          </article>
        );
      })}
    </Trace>
  );
}

/** One returned page: its records, shown a page at a time, keeping the selected record visible. */
function ToolResult({
  tool,
  result,
  itemSelected,
  selection,
}: {
  tool: string;
  result: ToolResultView;
  itemSelected: boolean;
  selection: RecordSelection;
}) {
  const [shown, setShown] = useState(PAGE);
  const keys = result.recordKeys ?? [];
  const isSelected = (key: string) =>
    selection.records[key]?.id === selection.selectedLog &&
    (!selection.selectedEvent || result.eventId === selection.selectedEvent || itemSelected);
  // Citation navigation must reveal the record even when it is past "Show more".
  const selectedIndex = keys.findIndex(isSelected);
  const visible = keys.slice(0, Math.max(shown, selectedIndex + 1));
  const remaining = keys.length - visible.length;
  return (
    <div className="tool-output">
      <div className="tool-output-label">
        Returned result{" "}
        <span>
          {result.recordKeys === null
            ? "No records accepted"
            : `${keys.length} ${tool === "get_logs" ? "logs" : keys.length === 1 ? "record" : "records"}`}
        </span>
      </div>
      {result.error && (
        <p className="notice notice-error">{result.error}</p>
      )}
      {result.recordKeys?.length === 0 && (
        <p className="empty-tool-result">
          {tool === "get_logs"
            ? "The tool returned an empty log list."
            : "The tool returned no records for these filters."}
        </p>
      )}
      {visible.map((key, index) => {
        const record = selection.records[key];
        if (!record) return null;
        const selected = isSelected(key);
        return (
          <div
            key={`${key}:${index}`}
            className="evidence-log"
            tabIndex={-1}
            data-selected={selected}
            data-record-type={record.type}
          >
            <RecordLine
              record={record}
              id={
                <button
                  className="record-id"
                  aria-label={`Inspect ${record.id}`}
                  aria-pressed={selected}
                  onClick={() => selection.onSelect(record.id, result.eventId)}
                >
                  {record.id}
                </button>
              }
            />
            {selected && (
              <button className="text-link record-open" onClick={selection.onOpen}>
                Open full record
              </button>
            )}
          </div>
        );
      })}
      {remaining > 0 && (
        <button className="show-more" onClick={() => setShown(visible.length + PAGE)}>
          Show {Math.min(PAGE, remaining)} more of {remaining}
        </button>
      )}
      {result.oversized.length > 0 && (
        <p className="oversized-note">
          Too large to return, so never received:{" "}
          {result.oversized.map((entry) => `${entry.id} (${entry.bytes.toLocaleString("en-US")} bytes)`).join(", ")}
        </p>
      )}
      {result.morePages && (
        <p className="oversized-note">The tool reported another page; the investigator decided whether to request it.</p>
      )}
      <p className="result-id mono">Result ID: {result.eventId}</p>
    </div>
  );
}

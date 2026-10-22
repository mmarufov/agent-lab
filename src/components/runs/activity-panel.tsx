"use client";
import { useEffect, type ReactNode } from "react";
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
} from "lucide-react";
import type { ActivityItem } from "@agent-lab/lab/web";
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
import { useScrollPosition } from "./use-scroll-position";

export function matchesEvent(item: ActivityItem, event: string | null) {
  return Boolean(
    event &&
    (item.id === event ||
      item.eventIds.some(
        (id) => id === event || `${id}:${item.tool?.callId}` === event,
      )),
  );
}

export function ActivityPanel({
  items,
  selectedLog,
  selectedEvent,
  expanded,
  onExpand,
  children,
  live,
  onClose,
  latestDismissed,
  onLatestDismissed,
}: {
  items: ActivityItem[];
  selectedLog: string | null;
  selectedEvent: string | null;
  expanded: Record<string, boolean>;
  onExpand: (id: string, open: boolean) => void;
  children: ReactNode;
  live: boolean;
  onClose: () => void;
  latestDismissed: boolean;
  onLatestDismissed: (value: boolean) => void;
}) {
  const { scroll, content, awayFromBottom, jumpToLatest, inspect, handlers } =
    useScrollPosition({ once: true, initialDismissed: latestDismissed, onDismiss: onLatestDismissed });
  const current = items.findLast(
    (item) => item.status === "running" || item.status === "queued",
  );
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
      <div
        className="activity-scroll"
        ref={scroll}
        role="region"
        aria-label="Activity timeline"
        tabIndex={0}
        {...handlers}
      >
        <div ref={content} className="activity-content">
          <section aria-label="Investigator steps">
            <h3 className="activity-stage-heading">
              Investigation <span>Eve</span>
            </h3>
            <ActivitySteps
              items={items.filter((item) => item.actor === "investigator")}
              selectedLog={selectedLog}
              selectedEvent={selectedEvent}
              expanded={expanded}
              onExpand={onExpand}
            />
          </section>
          {children}
        </div>
      </div>
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
      <div className="activity-footer" role="status">
        {current ? current.title : "All saved activity shown"}
      </div>
    </aside>
  );
}

export function ActivitySteps({
  items,
  selectedLog,
  selectedEvent,
  expanded,
  onExpand,
}: {
  items: ActivityItem[];
  selectedLog: string | null;
  selectedEvent: string | null;
  expanded: Record<string, boolean>;
  onExpand: (id: string, open: boolean) => void;
}) {
  const current = items.findLast(
    (item) => item.status === "running" || item.status === "queued",
  );
  return (
    <Trace className="activity-trace">
      {items.map((item) => {
        const selected = matchesEvent(item, selectedEvent);
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
            <p className="activity-detail">{item.detail}</p>
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
                    {item.tool && (
                      <>
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
                          <div className="tool-output" key={result.eventId}>
                            <div className="tool-output-label">
                              Returned result{" "}
                              <span>{result.logs?.length ?? "?"} logs</span>
                            </div>
                            {result.error && (
                              <p className="notice notice-error">
                                {result.error}
                              </p>
                            )}
                            {result.logs?.length === 0 && (
                              <p className="empty-tool-result">
                                The tool returned an empty log list.
                              </p>
                            )}
                            {result.logs?.map((log, logIndex) => (
                              <div
                                key={`${log.id}:${logIndex}`}
                                className="evidence-log"
                                tabIndex={-1}
                                data-selected={
                                  log.id === selectedLog &&
                                  (!selectedEvent ||
                                    result.eventId === selectedEvent ||
                                    selected)
                                }
                              >
                                <div className="log-meta">
                                  <span>{log.id}</span>
                                  <span
                                    className="log-level"
                                    data-level={log.level}
                                  >
                                    {log.level}
                                  </span>
                                </div>
                                <p>{log.message}</p>
                              </div>
                            ))}
                            <p className="result-id mono">
                              Result ID: {result.eventId}
                            </p>
                          </div>
                        ))}
                      </>
                    )}
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

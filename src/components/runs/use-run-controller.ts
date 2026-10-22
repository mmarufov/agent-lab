"use client";
import { useEffect, useRef, useState } from "react";
import type { RunView } from "@agent-lab/lab/web";
import { request, type Job } from "./request";

// One owner for detail-page delivery. GETs only restore saved state; the two
// explicit actions below are the only paths that can submit/cancel model work.
export function useRunController(initial: RunView) {
  const [run, setRun] = useState(initial);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "saved" | "reconnecting"
  >("connecting");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [awaitingJob, setAwaitingJob] = useState<Job | null>(null);
  const reconnect = useRef<() => void>(() => {});
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const actionAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    let disposed = false;
    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(retry);
      stream?.close();
      stream = undefined;
    };
    function connect() {
      close();
      if (disposed || document.visibilityState === "hidden") return;
      const source = new EventSource(`/api/runs/${initial.id}/stream`);
      stream = source;
      const current = () => !disposed && stream === source;
      source.addEventListener("snapshot", (event) => {
        if (!current()) return;
        try {
          const next: RunView = JSON.parse((event as MessageEvent).data);
          if (next.id !== initial.id)
            throw new Error("Unexpected investigation");
          setRun(next);
          setAwaitingJob((job) =>
            job && next.operations.some((operation) => operation.id === job.id)
              ? null
              : job,
          );
          setConnection("live");
        } catch {
          lost();
        }
      });
      source.addEventListener("settled", () => {
        if (!current()) return;
        setConnection("saved");
        close();
      });
      function lost() {
        if (!current()) return;
        close();
        setConnection("reconnecting");
        retry = setTimeout(connect, 1_000);
      }
      source.addEventListener("unavailable", lost);
      source.onerror = lost;
    }
    reconnect.current = connect;
    const visibility = () =>
      document.visibilityState === "hidden" ? close() : connect();
    connect();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", connect);
    return () => {
      disposed = true;
      close();
      actionAbort.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", connect);
    };
  }, [initial.id]);

  async function review() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setActionError("");
    requestId.current ??= crypto.randomUUID();
    const abort = new AbortController();
    actionAbort.current = abort;
    try {
      const job = await request<Job>(
        "/api/jobs",
        { requestId: requestId.current, kind: "review", runId: initial.id },
        abort.signal,
      );
      requestId.current = null;
      setAwaitingJob(job);
      reconnect.current();
    } catch (error) {
      if (!abort.signal.aborted)
        setActionError(
          error instanceof Error
            ? error.message
            : "Review could not be started.",
        );
    } finally {
      submitting.current = false;
      if (!abort.signal.aborted) setPending(false);
    }
  }
  const operation =
    run.operations.find((job) => ["queued", "running"].includes(job.status)) ??
    (awaitingJob && ["queued", "running"].includes(awaitingJob.status)
      ? awaitingJob
      : null);
  async function cancel() {
    if (!operation || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setActionError("");
    const abort = new AbortController();
    actionAbort.current = abort;
    try {
      const job = await request<Job>(
        `/api/jobs/${operation.id}/cancel`,
        {},
        abort.signal,
      );
      setRun((previous) => ({
        ...previous,
        operations: previous.operations.map((item) =>
          item.id === job.id
            ? {
                ...item,
                status: job.status as typeof item.status,
                cancelRequested: job.cancelRequested,
              }
            : item,
        ),
      }));
      setAwaitingJob((previous) => (previous?.id === job.id ? job : previous));
      reconnect.current();
    } catch {
      if (!abort.signal.aborted)
        setActionError("Cancellation could not be confirmed. Try again.");
    } finally {
      submitting.current = false;
      if (!abort.signal.aborted) setPending(false);
    }
  }
  return {
    run,
    connection,
    pending,
    actionError,
    operation,
    awaitingJob,
    review,
    cancel,
    refresh: () => reconnect.current(),
  };
}

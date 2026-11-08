"use client";
import { caseNames } from "@agent-lab/contracts";
import type { DailyCaptureListing } from "@agent-lab/lab/daily-evidence";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AudioWaveform, Circle, FlaskConical, Play, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, recordedAt } from "./display";
import { request, RequestError, type Job, type Runner } from "./request";

type Captures =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: DailyCaptureListing[] };

const count = (value: number, noun: string) => `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;

/** The new-investigation form: a saved Daily recording by default, or one of the simulated cases. */
export function LaunchForm({ onLaunched, onClose }: { onLaunched: (job: Job) => void; onClose: () => void }) {
  const [source, setSource] = useState<"daily_capture" | "simulated">("daily_capture");
  const [caseId, setCaseId] = useState("missing-config");
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<Captures>({ state: "loading" });
  const [runner, setRunner] = useState<Runner | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // One request ID per choice: resubmitting the same choice cannot start it twice.
  const requestId = useRef<string | null>(null);
  // Bumped by Refresh. The first render already shows the list loading.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const { captures: items } = await request<{ captures: DailyCaptureListing[] }>("/api/captures", undefined, abort.signal);
        setCaptures({ state: "ready", items });
        setCaptureId((current) =>
          items.some((item) => item.available && item.captureId === current)
            ? current
            : (items.find((item) => item.available)?.captureId ?? null),
        );
      } catch (failure) {
        if (abort.signal.aborted) return;
        setCaptures({ state: "error", message: failure instanceof Error ? failure.message : "Saved recordings could not be listed." });
      }
    })();
    return () => abort.abort();
  }, [reload]);
  const loadCaptures = () => {
    setCaptures({ state: "loading" });
    setReload((value) => value + 1);
  };
  const checkRunner = useCallback(async (signal?: AbortSignal) => {
    try {
      setRunner(await request<Runner>("/api/runner", undefined, signal));
    } catch {
      if (!signal?.aborted) setRunner(null);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (document.visibilityState === "visible") await checkRunner(abort.signal);
      if (!disposed) timer = setTimeout(tick, 2_000);
    }
    void tick();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [checkRunner]);

  const available = captures.state === "ready" ? captures.items.filter((item) => item.available) : [];
  const unavailable = captures.state === "ready" ? captures.items.filter((item) => !item.available) : [];
  const chosen = available.find((item) => item.captureId === captureId);
  const ready = Boolean(runner?.online && runner.enabled && !runner.busy);
  const choiceReady = source === "simulated" || Boolean(chosen);

  async function submit() {
    if (pending || !choiceReady) return;
    setPending(true);
    setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const job = await request<Job>(
        "/api/jobs",
        source === "daily_capture"
          ? { requestId: requestId.current, kind: "investigate", source: "daily_capture", captureId }
          : { requestId: requestId.current, kind: "investigate", caseId },
      );
      requestId.current = null;
      onLaunched(job);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed.");
      // The recording changed or disappeared since the list was read.
      if (failure instanceof RequestError && (failure.status === 404 || failure.status === 422) && source === "daily_capture") {
        requestId.current = null;
        loadCaptures();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="action-sheet">
      <div className="form-field">
        <label htmlFor="source">Source</label>
        <Select
          value={source}
          onValueChange={(value) => {
            setSource(value as typeof source);
            setError("");
            requestId.current = null;
          }}
        >
          <SelectTrigger id="source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily_capture" description="A saved local sandbox incident">
              Daily recording
            </SelectItem>
            <SelectItem value="simulated" description="Authored deployment logs with a known outcome">
              Simulated case
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {source === "daily_capture" ? (
        <>
          <Alert className="launch-explainer" role="note">
            <AudioWaveform />
            <AlertTitle>A recorded local sandbox incident</AlertTitle>
            <AlertDescription>
              <p>
                Eve reads the HTTP observations and application logs that pnpm daily:capture saved from the local Daily
                sandbox. Starting an investigation does not stop a database, touch the sandbox, or create another capture.
              </p>
            </AlertDescription>
          </Alert>
          {captures.state === "loading" && (
            <div className="form-field" aria-label="Loading saved recordings">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-9 w-full" />
            </div>
          )}
          {captures.state === "error" && (
            <Alert variant="destructive" className="launch-explainer">
              <AlertTitle>Saved recordings could not be listed</AlertTitle>
              <AlertDescription>
                <p>{captures.message}</p>
                <Button variant="outline" size="sm" onClick={loadCaptures}>
                  <RefreshCw size={13} /> Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {captures.state === "ready" && available.length === 0 && (
            <Empty
              title={captures.items.length ? "No recording can be investigated" : "No saved recordings yet"}
              action={
                <div className="actions-group">
                  <Button variant="outline" size="sm" onClick={() => setSource("simulated")}>
                    <FlaskConical size={13} /> Use a simulated case
                  </Button>
                  <Button variant="ghost" size="sm" onClick={loadCaptures}>
                    <RefreshCw size={13} /> Refresh
                  </Button>
                </div>
              }
            >
              {captures.items.length
                ? "Every saved recording failed verification or is incomplete. The reasons are listed below. Record a new one with pnpm daily:capture."
                : "Record one with pnpm daily:capture in a terminal. That command runs the local Daily sandbox and briefly stops its database; this form never does."}
            </Empty>
          )}
          {available.length > 0 && (
            <div className="form-field">
              <label htmlFor="recording">Recording</label>
              <Select
                value={captureId ?? undefined}
                onValueChange={(value) => {
                  setCaptureId(value);
                  setError("");
                  requestId.current = null;
                }}
              >
                <SelectTrigger id="recording">
                  <SelectValue placeholder="Choose a recording" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((item) =>
                    item.available ? (
                      <SelectItem
                        key={item.captureId}
                        value={item.captureId}
                        description={`${count(item.httpObservations, "HTTP observation")} · ${count(item.logLines, "log line")} · ${item.captureId}`}
                      >
                        {recordedAt(item.recordedAt)}
                      </SelectItem>
                    ) : null,
                  )}
                </SelectContent>
              </Select>
              {chosen && (
                <dl className="recording-facts">
                  <dt>Recorded</dt>
                  <dd>
                    {recordedAt(chosen.recordedAt)}
                    {chosen.finishedAt ? ` to ${recordedAt(chosen.finishedAt).split(", ").at(-1)}` : ""}
                  </dd>
                  <dt>Records</dt>
                  <dd>
                    {count(chosen.httpObservations, "HTTP observation")}, {count(chosen.logLines, "log line")}
                  </dd>
                  <dt>Capture ID</dt>
                  <dd className="mono">{chosen.captureId}</dd>
                </dl>
              )}
            </div>
          )}
          {unavailable.length > 0 && (
            <Collapsible className="unavailable-recordings" defaultOpen={available.length === 0}>
              <CollapsibleTrigger className="text-link text-xs">
                {count(unavailable.length, "recording")} can&apos;t be investigated
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul>
                  {unavailable.map((item) =>
                    item.available ? null : (
                      <li key={item.captureId}>
                        <span className="mono">{item.captureId}</span>
                        <span>{item.problem.message}</span>
                      </li>
                    ),
                  )}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
          <p className="footnote">
            This makes real model calls through AI Gateway, within the investigator&apos;s usage limits; reported usage
            is saved with the run. Evidence coverage is checked automatically afterward without a model. The separate
            review starts only when you request it.
          </p>
        </>
      ) : (
        <>
          <div className="form-field">
            <label htmlFor="case">Case</label>
            <Select
              value={caseId}
              onValueChange={(value) => {
                setCaseId(value);
                requestId.current = null;
              }}
            >
              <SelectTrigger id="case">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(caseNames).map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="footnote">
            Eve runs against a fresh simulated trial. This makes real model calls
            through AI Gateway. Reported usage is saved with the run. The separate
            review starts only when you request it.
          </p>
        </>
      )}
      <div className="worker-state" role="status">
        <Circle size={10} aria-hidden="true" />
        {runner === undefined
          ? "Checking the local worker…"
          : runner === null
            ? "The local service did not answer. Check that pnpm dev:lab is running."
            : !runner.enabled
              ? "Browser execution is disabled for this workspace. Saved investigations can still be read."
              : !runner.online
                ? "Worker offline. Run pnpm dev:lab to start the full workbench."
                : runner.busy
                  ? "Worker busy with another operation. Wait for it to finish."
                  : "Local worker ready"}
        {runner !== undefined && (runner === null || !runner.online) && (
          <button className="text-link" onClick={() => void checkRunner()}>
            Refresh status
          </button>
        )}
      </div>
      {runner?.activeJob && (
        <p className="mb-4">
          <Link
            className="text-link text-xs"
            href={
              runner.activeJob.runId
                ? `/runs/${runner.activeJob.runId}?job=${runner.activeJob.id}`
                : `/runs?job=${runner.activeJob.id}`
            }
            onClick={onClose}
          >
            View active operation
          </Link>
        </p>
      )}
      <Button onClick={() => void submit()} disabled={!ready || pending || !choiceReady}>
        <Play size={14} />
        {pending ? "Starting investigation…" : "Run investigation"}
      </Button>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
    </div>
  );
}

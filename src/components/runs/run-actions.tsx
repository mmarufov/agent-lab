"use client";
import { caseNames } from "@agent-lab/contracts";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LoaderCircle, Square, Play, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { request, RequestError, type Job, type Runner } from "./request";
export function RunActions({
  label,
  icon,
}: {
  label: string;
  icon?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [caseId, setCaseId] = useState("missing-config");
  const [runner, setRunner] = useState<Runner | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (document.visibilityState === "visible") {
        try {
          const value = await request<Runner>(
            "/api/runner",
            undefined,
            abort.signal,
          );
          if (!disposed) {
            setRunner(value);
          }
        } catch {
          if (!disposed) setRunner(null);
        }
      }
      if (!disposed && open) timer = setTimeout(tick, 2_000);
    }
    void tick();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [open]);
  async function submit() {
    if (pending) return;
    setPending(true);
    setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const job = await request<Job>("/api/jobs", {
        requestId: requestId.current,
        kind: "investigate",
        caseId,
      });
      requestId.current = null;
      setOpen(false);
      window.dispatchEvent(new Event("lab:refresh"));
      router.push(`/runs?job=${job.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setPending(false);
    }
  }
  const ready = runner?.online && runner.enabled && !runner.busy;
  return (
    <div>
      <Button onClick={() => setOpen(true)} disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : icon}
        {label}
      </Button>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New investigation</SheetTitle>
            <SheetDescription>
              Run Eve against a fresh simulated trial. The answer and every
              returned log will be saved.
            </SheetDescription>
          </SheetHeader>
          <div className="action-sheet">
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
              This makes real model calls through AI Gateway. Reported usage is
              saved with the run. The separate review starts only when you
              request it.
            </p>
            <div className="worker-state">
              <Circle size={10} />
              {runner && !runner.enabled
                ? "Browser execution is disabled for this workspace."
                : runner?.busy
                  ? "Worker busy. Wait for the active operation."
                  : ready
                    ? "Local worker ready"
                    : "Worker offline. Run pnpm dev:lab to start the full workbench."}
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
                  onClick={() => setOpen(false)}
                >
                  View active operation
                </Link>
              </p>
            )}
            <Button onClick={() => void submit()} disabled={!ready || pending}>
              <Play size={14} />
              {pending ? "Starting investigation…" : "Run investigation"}
            </Button>
            {error && (
              <p role="alert" className="notice notice-error">
                {error}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
export function ActiveJob({ jobId }: { jobId: string | null }) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (document.visibilityState !== "visible") {
        if (!disposed) timer = setTimeout(tick, 1_000);
        return;
      }
      try {
        const value = await request<Job>(
          `/api/jobs/${jobId}`,
          undefined,
          abort.signal,
        );
        if (disposed) return;
        setJob(value);
        setError("");
        window.dispatchEvent(new Event("lab:refresh"));
        if (
          value.runId &&
          value.kind === "investigate" &&
          !window.location.pathname.endsWith(value.runId)
        )
          router.replace(`/runs/${value.runId}?job=${value.id}`);
        if (!["queued", "running"].includes(value.status)) {
          router.refresh();
          return;
        }
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) {
          if (!disposed) setError("This saved operation was not found.");
          return;
        }
        if (!disposed)
          setError("Connection lost. Reconnecting to saved progress…");
      }
      if (!disposed) timer = setTimeout(tick, 1_000);
    }
    void tick();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [jobId, router]);
  if (!jobId || (job && job.status === "completed")) return null;
  return (
    <div className="notice" role="status">
      <div className="actions-group">
        <span>
          {error ||
            job?.error ||
            (job?.cancelRequested && ["queued", "running"].includes(job.status)
              ? "Cancellation requested…"
              : job?.status === "running"
                ? "Preparing investigation. You can leave this page and return later."
                : job?.status === "cancelled"
                  ? "Operation cancelled. Saved progress is retained."
                  : job?.status === "failed"
                    ? "Operation failed. Saved progress is retained."
                    : "Preparing operation…")}
        </span>
        {job && ["running", "queued"].includes(job.status) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={job.cancelRequested}
            onClick={async () => {
              try {
                setJob(await request<Job>(`/api/jobs/${job.id}/cancel`, {}));
              } catch {
                setError("Cancellation could not be confirmed. Try again.");
              }
            }}
          >
            <Square size={12} />
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

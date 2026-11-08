"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { LaunchForm } from "./launch-form";
import { request, RequestError, type Job } from "./request";
export function RunActions({
  label,
  icon,
}: {
  label: string;
  icon?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>
        {icon}
        {label}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="launch-sheet overflow-y-auto">
          <SheetHeader>
            <SheetTitle>New investigation</SheetTitle>
            <SheetDescription>
              Eve investigates saved evidence through read-only tools. The
              answer, every tool request, and every returned record are saved.
            </SheetDescription>
          </SheetHeader>
          {/* Mounted while open: recordings and the worker are read when it opens. */}
          <LaunchForm
            onClose={() => setOpen(false)}
            onLaunched={(job) => {
              setOpen(false);
              window.dispatchEvent(new Event("lab:refresh"));
              router.push(`/runs?job=${job.id}`);
              router.refresh();
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
// Follows a submitted investigation until its run exists, then hands over to
// the run page. Reading never changes the operation; only Cancel does.
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
  const daily = job?.command?.kind === "investigate" && job.command.source === "daily_capture";
  const failed = job && ["failed", "cancelled"].includes(job.status);
  return (
    <div className={`notice ${failed && job.error ? "notice-error" : ""}`} role="status">
      <div className="actions-group">
        {job && ["queued", "running"].includes(job.status) && (
          <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />
        )}
        <span>
          {error ||
            job?.error ||
            (job?.cancelRequested && ["queued", "running"].includes(job.status)
              ? "Cancellation requested…"
              : job?.status === "running"
                ? daily
                  ? "Verifying the recording and starting Eve. You can leave this page and return later."
                  : "Preparing investigation. You can leave this page and return later."
                : job?.status === "queued"
                  ? "Waiting for the local worker…"
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

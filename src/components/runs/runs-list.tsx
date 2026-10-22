"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, FlaskConical, Plus } from "lucide-react";
import type { RunsPage } from "@agent-lab/lab/web";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Empty, Status, duration, money, timestamp } from "./display";
import { RunActions, ActiveJob } from "./run-actions";
export function RunsList({
  initial,
  deployment,
  status,
}: {
  initial: RunsPage;
  deployment: string;
  status: string;
}) {
  const router = useRouter();
  const search = useSearchParams();
  function filter(key: string, value: string) {
    const next = new URLSearchParams(search);
    next.delete("cursor");
    if (value === "all") next.delete(key);
    else next.set(key, value);
    router.push(`/runs?${next}`);
  }
  const more = new URLSearchParams(search);
  if (initial.nextCursor) more.set("cursor", initial.nextCursor);
  return (
    <main id="main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">OBSERVE / VERIFY</p>
          <h1>
            Investigations
            <span className="heading-period" aria-hidden="true">
              .
            </span>
          </h1>
          <p className="page-description">
            Follow the answer back to the evidence.
          </p>
        </div>
        <RunActions label="New investigation" icon={<Plus size={15} />} />
      </div>
      <ActiveJob jobId={search.get("job")} />
      <div className="collection-toolbar">
        <div className="filter-controls">
          <Select
            value={deployment}
            onValueChange={(value) => filter("deployment", value)}
          >
            <SelectTrigger aria-label="Filter deployment" className="w-[155px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All deployments</SelectItem>
              {["A", "B", "C"].map((id) => (
                <SelectItem key={id} value={id}>
                  Deployment {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => filter("status", value)}
          >
            <SelectTrigger aria-label="Filter status" className="w-[145px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["running", "completed", "failed", "cancelled"].map((id) => (
                <SelectItem key={id} value={id}>
                  {id[0].toUpperCase() + id.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="collection-note">
          <FlaskConical size={13} />
          Authored simulation cases
        </span>
      </div>
      <div className="run-table-panel">
        {initial.items.length === 0 ? (
          <Empty
            title={
              deployment !== "all" || status !== "all"
                ? "No matching investigations"
                : "Your first investigation starts here"
            }
          >
            Choose a simulated case and run the investigator. Its evidence
            and review will be saved here.
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Investigation</TableHead>
                <TableHead>Execution</TableHead>
                <TableHead className="hide-phone">Model</TableHead>
                <TableHead className="hide-tablet">Started · UTC</TableHead>
                <TableHead className="hide-phone text-right">
                  Duration
                </TableHead>
                <TableHead className="hide-tablet text-right">
                  Model cost
                </TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.items.map((run) => (
                <TableRow key={run.id} className="group">
                  <TableCell className="pl-5">
                    <Link className="run-name" href={`/runs/${run.id}`}>
                      <span className="deployment-mark">
                        {run.deploymentId}
                      </span>
                      <span>
                        <strong>{run.caseName ?? `Deployment ${run.deploymentId}`}</strong>
                        <span className="run-id">{run.id.slice(0, 8)}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Status value={run.status} />
                    <div className="mt-1 text-xs"><Status value={run.outcomeStatus} label={run.outcomeStatus === "pass" ? "Outcome passed" : run.outcomeStatus === "fail" ? "Outcome failed" : "Outcome not assessed"} /></div>
                  </TableCell>
                  <TableCell className="hide-phone">
                    <span className="model-name">
                      {run.modelId?.split("/").at(-1) ??
                        (run.status === "running" ? "Pending" : "Not recorded")}
                    </span>
                    <span className="provider-name">
                      {run.modelId?.split("/")[0] ?? "No model recorded"}
                    </span>
                  </TableCell>
                  <TableCell className="hide-tablet secondary-text">
                    {timestamp(run.startedAt)}
                  </TableCell>
                  <TableCell className="hide-phone numeric text-right">
                    {run.durationMs === null && run.status !== "running"
                      ? "Unavailable"
                      : duration(run.durationMs)}
                  </TableCell>
                  <TableCell className="hide-tablet numeric text-right">
                    {money(run.costUsd)}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/runs/${run.id}`}
                      className="open-run"
                      aria-label={`Open investigation ${run.id}`}
                    >
                      <ArrowRight size={16} />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="collection-footer">
        <span>
          {initial.items.length} investigation
          {initial.items.length === 1 ? "" : "s"} shown{" "}
          <span className="footer-separator">/</span> Newest first
        </span>
        {initial.nextCursor && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/runs?${more}`}>
              Older investigations <ArrowRight />
            </Link>
          </Button>
        )}
      </div>
      <div className="method-note">
        <span className="method-index">01 / 03</span>
        <p>
          <strong>Investigate. Inspect. Review.</strong> Each answer stays
          connected to the logs the agent actually received. A separate reviewer
          assesses what those logs support.
        </p>
      </div>
    </main>
  );
}

"use client";
import { useState, type ReactNode } from "react";
import { WrapText } from "lucide-react";
import type { ReceivedEvidence, RecordView } from "@agent-lab/lab/web";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { clock, duration } from "./display";

type Http = Extract<RecordView, { type: "http" }>;

/** What a request got back, in a few words: a status, a timeout, or a network error. */
export function httpOutcome(record: Http) {
  if (record.outcome === "response") return `HTTP ${record.response.status}`;
  if (record.outcome === "timeout") return `No response within ${duration(record.deadlineMs)}`;
  return `Network error${record.error.code ? ` ${record.error.code}` : ""}`;
}
const outcomeTone = (record: Http) =>
  record.outcome !== "response" || record.response.status >= 500
    ? "error"
    : record.response.status >= 400
      ? "warn"
      : "info";

/** The body exactly as recorded: JSON indented for reading, text as it is. */
export function httpBody(record: Http) {
  if (record.outcome !== "response") return null;
  const { body, bodyFormat } = record.response;
  return bodyFormat === "json" ? JSON.stringify(body, null, 2) : String(body ?? "");
}

const kindLabel = (record: RecordView) =>
  record.type === "http" ? "HTTP observation" : record.type === "daily_log" ? "Log line" : "Deployment log";

// The record as the tool returned it, without the workbench's type tag.
const raw = (record: RecordView) => {
  const copy: Record<string, unknown> = { ...record };
  delete copy.type;
  return JSON.stringify(copy, null, 2);
};

/** One record as a compact line: its ID, what it is, and when. */
export function RecordLine({ record, id }: { record: RecordView; id?: ReactNode }) {
  const label = id ?? <span className="record-id">{record.id}</span>;
  if (record.type === "http")
    return (
      <>
        <div className="log-meta">
          {label}
          <span className="record-request">
            {record.method} {record.path}
          </span>
          <span className="log-level" data-level={outcomeTone(record)}>
            {httpOutcome(record)}
          </span>
        </div>
        <p className="record-facts">
          {clock(record.startedAt)} · {duration(record.elapsedMs)}
          {record.authenticated ? "" : " · unauthenticated"}
        </p>
      </>
    );
  if (record.type === "daily_log")
    return (
      <>
        <div className="log-meta">
          {label}
          <span>{record.service}</span>
          <span>{clock(record.timestamp)}</span>
          <span className="log-level" data-level={record.stream === "stderr" ? "warn" : "info"}>
            {record.stream}
          </span>
        </div>
        <p className="record-message">{record.message || "(empty line)"}</p>
      </>
    );
  return (
    <>
      <div className="log-meta">
        {label}
        <span className="log-level" data-level={record.level}>
          {record.level}
        </span>
      </div>
      <p>{record.message}</p>
    </>
  );
}

/** Plain text in a Code Block, with wrapping and copying. No syntax highlighting. */
export function PlainCode({ title, value, wrap: initialWrap = true }: { title: string; value: string; wrap?: boolean }) {
  const [wrap, setWrap] = useState(initialWrap);
  return (
    <CodeBlock size="sm" className="record-code">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 [&_svg]:size-3.5"
            aria-label={`Wrap ${title.toLowerCase()} lines`}
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText />
          </Button>
          <CodeBlockCopyButton value={value} aria-label={`Copy ${title.toLowerCase()}`} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap}>{value}</CodeBlockContent>
    </CodeBlock>
  );
}

/** Every field of one record, for the evidence Sheet. Raw JSON stays secondary. */
export function RecordDetails({
  record,
  receipts,
  onViewTrace,
}: {
  record: RecordView;
  /** The tool calls that returned it; absent for a record the investigator never received. */
  receipts?: ReceivedEvidence["receipts"];
  onViewTrace?: (resultEventId: string) => void;
}) {
  const body = record.type === "http" ? httpBody(record) : null;
  return (
    <div className="record-details">
      <dl className="record-fields">
        <dt>Record</dt>
        <dd>
          {record.id} · {kindLabel(record)}
        </dd>
        {record.type === "http" ? (
          <>
            <dt>Request</dt>
            <dd>
              {record.method} {record.path}
              {record.authenticated ? " · with the sandbox session" : " · without credentials"}
            </dd>
            <dt>Outcome</dt>
            <dd>{httpOutcome(record)}</dd>
            {record.outcome === "network_error" && (
              <>
                <dt>Error</dt>
                <dd>
                  {record.error.name}: {record.error.message}
                </dd>
              </>
            )}
            <dt>Started</dt>
            <dd>{record.startedAt}</dd>
            <dt>Ended</dt>
            <dd>{record.endedAt}</dd>
            <dt>Duration</dt>
            <dd>
              {duration(record.elapsedMs)} of a {duration(record.deadlineMs)} deadline
            </dd>
            {record.outcome === "response" && (
              <>
                <dt>Body</dt>
                <dd>
                  {record.response.bodyBytes.toLocaleString("en-US")} bytes, {record.response.bodyFormat}
                  {record.response.bodyTruncated ? " · truncated when it was recorded" : ""}
                </dd>
                {Object.entries(record.response.headers).map(([name, value]) => (
                  <HeaderField key={name} name={name} value={value} />
                ))}
              </>
            )}
          </>
        ) : record.type === "daily_log" ? (
          <>
            <dt>Service</dt>
            <dd>
              {record.service} · {record.stream}
            </dd>
            <dt>Received</dt>
            <dd>{record.timestamp ?? "Docker printed no timestamp for this line"}</dd>
          </>
        ) : (
          <>
            <dt>Deployment</dt>
            <dd>{record.deploymentId}</dd>
            <dt>Level</dt>
            <dd>{record.level}</dd>
          </>
        )}
      </dl>
      {body !== null && <PlainCode title="Response body" value={body} />}
      {record.type !== "http" && <PlainCode title="Message" value={record.message} />}
      {receipts && receipts.length > 0 && (
        <div className="receipt">
          <h3>Returned by</h3>
          {receipts.map((receipt) => (
            <dl key={`${receipt.resultEventId}:${receipt.callId}`}>
              <dt>Tool</dt>
              <dd>{receipt.toolName}</dd>
              <dt>Call ID</dt>
              <dd>{receipt.callId}</dd>
              <dt>Result ID</dt>
              <dd>{receipt.resultEventId}</dd>
              {onViewTrace && (
                <dd className="receipt-action">
                  <button className="text-link" onClick={() => onViewTrace(receipt.resultEventId)}>
                    View in activity
                  </button>
                </dd>
              )}
            </dl>
          ))}
        </div>
      )}
      <details className="raw-record">
        <summary>Raw JSON</summary>
        <PlainCode title="Raw record" value={raw(record)} wrap={false} />
      </details>
    </div>
  );
}

function HeaderField({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="header-name">{name}</dt>
      <dd>{value}</dd>
    </>
  );
}

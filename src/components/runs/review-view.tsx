"use client";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { RunView } from "@agent-lab/lab/web";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, Status, money, timestamp, tokens } from "./display";
export function ReviewView({
  reviews,
  selectedId,
  onSelectReview,
  citations,
  stale,
}: {
  reviews: RunView["reviews"];
  selectedId: string | null;
  onSelectReview: (id: string) => void;
  citations: (ids: string[]) => ReactNode;
  /** The record no longer verifies, so saved reviews describe an earlier state of it. */
  stale: boolean;
}) {
  const review = reviews.find((item) => item.id === selectedId) ?? reviews[0];
  return (
    <>
      {stale && review && (
        <Alert variant="destructive" className="section-alert">
          <AlertTitle>Saved for an earlier state of this record</AlertTitle>
          <AlertDescription>
            <p>
              These reviews were created while the investigation&apos;s record verified. It no longer matches its
              fingerprint, so they do not show that the current record is supported.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {reviews.length > 1 && (
        <Select value={review.id} onValueChange={onSelectReview}>
          <SelectTrigger aria-label="Review attempt" className="mb-5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {reviews.map((item, index) => (
              <SelectItem key={item.id} value={item.id}>
                {index === 0 ? "Latest" : `Earlier attempt ${index}`} ·{" "}
                {timestamp(item.startedAt)} · {item.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!review ? (
        <Empty title="No review yet">
          A separate model can assess each claim against the received evidence,
          in a fresh context. It is a paid request that starts only when you ask.
        </Empty>
      ) : (
        <>
          {!review.review && (
            <div className="review-metadata">
              <Status value={review.status} />
            </div>
          )}
          {review.error && (
            <p className="notice notice-error">{review.error}</p>
          )}
          {review.review ? (
            <Collapsible key={review.id} defaultOpen className="review-result">
              <CollapsibleTrigger
                className="review-result-trigger"
                aria-label="Review result"
              >
                <span>Review result</span>
                <Status value={review.status} />
                <ChevronDown size={14} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="review-summary">{review.review.summary}</p>
                {review.review.claims.map((claim, index) => (
                  <article className="claim" key={index}>
                    <div className="trace-heading">
                      <Status value={claim.verdict} />
                      <span className="eyebrow mb-0!">{claim.field}</span>
                    </div>
                    <blockquote>“{claim.quote}”</blockquote>
                    <p className="claim-explanation">{claim.explanation}</p>
                    {citations(claim.evidenceIds)}
                  </article>
                ))}
                {review.review.missingEvidence.length > 0 && (
                  <div className="uncertainty">
                    <h2>Evidence still needed</h2>
                    <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-2">
                      {review.review.missingEvidence.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          ) : review.status === "running" ? (
            <Empty title="Review in progress">
              The reviewer is assessing the answer and evidence in a separate
              request.
            </Empty>
          ) : null}
          <p className="footnote">
            Model judgments are advisory. A completed review cannot override a
            failed evidence check.
          </p>
          <details className="run-metadata">
            <summary>
              Review details <span>{review.modelId}</span>
            </summary>
            <dl>
              <dt>Model</dt>
              <dd>{review.modelId}</dd>
              <dt>Input</dt>
              <dd>
                Saved answer and {review.inputRecords} received record
                {review.inputRecords === 1 ? "" : "s"}
              </dd>
              <dt>Reported model cost</dt>
              <dd>{money(review.usage.costUsd)}</dd>
              <dt>Tokens</dt>
              <dd>
                {tokens(review.usage.inputTokens, review.usage.outputTokens)}
              </dd>
              <dt>Prompt version</dt>
              <dd>{review.promptVersion}</dd>
              <dt>Review ID</dt>
              <dd>{review.id}</dd>
            </dl>
          </details>
        </>
      )}
    </>
  );
}

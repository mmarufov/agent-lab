import {
  Check,
  Circle,
  LoaderCircle,
  X,
  Minus,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Empty as EmptyRoot,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
export function Status({ value, label }: { value: string; label?: string }) {
  const good = ["completed", "pass", "supported", "covered"].includes(value),
    bad = ["failed", "fail", "unsupported", "interrupted", "missed", "check_failed", "mismatch", "missing"].includes(value),
    active = ["running", "queued", "checking"].includes(value),
    uncertain = ["uncertain", "warn"].includes(value);
  const Icon = good
    ? Check
    : bad
      ? X
      : active
        ? LoaderCircle
        : uncertain
          ? AlertTriangle
          : value === "cancelled"
            ? Minus
            : Circle;
  return (
    <span
      className={cn(
        "status-label",
        good && "status-good",
        bad && "status-bad",
        active && "status-active",
        uncertain && "status-warn",
      )}
    >
      <Icon
        size={13}
        className={active ? "motion-safe:animate-spin" : undefined}
        aria-hidden="true"
      />
      {label ??
        value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase())}
    </span>
  );
}
export function money(value: number | null) {
  return value === null
    ? "Unavailable"
    : `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}
export function duration(value: number | null) {
  return value === null
    ? "In progress"
    : value < 1_000
      ? `${Math.round(value)}ms`
      : `${(value / 1_000).toFixed(1)}s`;
}
export function tokens(input: number | null, output: number | null) {
  if (input === null && output === null) return "Unavailable";
  return `${input?.toLocaleString("en-US") ?? "Unknown"} in / ${output?.toLocaleString("en-US") ?? "Unknown"} out`;
}
const months = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export function timestamp(value: string) {
  // Intl's punctuation differs between Node and Safari even with an explicit
  // locale/timezone. Keep SSR and the first browser render byte-for-byte equal.
  const date = new Date(value);
  const month = months[date.getUTCMonth()];
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${date.getUTCDate()}, ${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}
/** A recording's date and 24-hour UTC time, such as "Oct 22, 2026, 05:01:38 UTC". Same reason as timestamp. */
export function recordedAt(value: string) {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}
/** The time of day of an RFC 3339 timestamp, to the millisecond, in UTC. */
export function clock(value: string | null) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(11, 23)} UTC`;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <EmptyRoot className="empty-state">
      <EmptyHeader>
        <EmptyMedia className="empty-glyph" aria-hidden="true">
          [ · ]
        </EmptyMedia>
        <EmptyTitle className="empty-title">
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription className="empty-description">{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyRoot>
  );
}

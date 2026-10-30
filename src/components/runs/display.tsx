import {
  Check,
  Circle,
  LoaderCircle,
  X,
  Minus,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
export function Status({ value, label }: { value: string; label?: string }) {
  const good = ["completed", "pass", "supported"].includes(value),
    bad = ["failed", "fail", "unsupported", "interrupted"].includes(value),
    active = ["running", "queued"].includes(value),
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
export function timestamp(value: string) {
  // Intl's punctuation differs between Node and Safari even with an explicit
  // locale/timezone. Keep SSR and the first browser render byte-for-byte equal.
  const date = new Date(value);
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][date.getUTCMonth()];
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${date.getUTCDate()}, ${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph" aria-hidden="true">
        [ · ]
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

import { dailyCaptureIdSchema } from "@agent-lab/contracts/daily-capture";
import {
  dailyEvidenceErrorSchema,
  getDailyHttpObservationsInputSchema,
  getDailyHttpObservationsOutputSchema,
  getDailyLogsInputSchema,
  getDailyLogsOutputSchema,
  type GetDailyHttpObservationsInput,
  type GetDailyHttpObservationsOutput,
  type GetDailyLogsInput,
  type GetDailyLogsOutput,
} from "@agent-lab/contracts/daily-evidence";

export interface DailyEvidenceConfig {
  baseUrl: string;
  /** Bearer token of one capture access grant. */
  token: string;
  /** The recording the grant must serve; a response from any other source is refused. */
  captureId: string;
  evidenceSha256: string;
  /** Ends the request early, for example when the agent's turn is cancelled. */
  signal?: AbortSignal;
}

// Like getLogs, these functions know only the public HTTP contract. Reading
// capture files and checking grants belong to the trusted lab service.

/** One page of log lines recorded from Daily's containers during the configured capture. */
export async function getDailyLogs(input: GetDailyLogsInput, config: DailyEvidenceConfig): Promise<GetDailyLogsOutput> {
  const parsed = getDailyLogsInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`get_daily_logs: ${issue(parsed.error)}`);
  const { service, messageContains } = parsed.data;
  const page = await request("get_daily_logs", "/api/tools/daily/get-logs", parsed.data, config, getDailyLogsOutputSchema);
  const needle = messageContains?.toLowerCase();
  if (page.logs.some((log) => (service && log.service !== service) || (needle && !log.message.toLowerCase().includes(needle))))
    throw new Error("get_daily_logs received log lines that do not match the requested filters.");
  return page;
}

/** One page of the HTTP requests recorded during the configured capture, with what was observed for each. */
export async function getDailyHttpObservations(
  input: GetDailyHttpObservationsInput,
  config: DailyEvidenceConfig,
): Promise<GetDailyHttpObservationsOutput> {
  const parsed = getDailyHttpObservationsInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`get_daily_http_observations: ${issue(parsed.error)}`);
  const { path } = parsed.data;
  const page = await request(
    "get_daily_http_observations",
    "/api/tools/daily/get-http-observations",
    parsed.data,
    config,
    getDailyHttpObservationsOutputSchema,
  );
  if (path && page.observations.some((observation) => observation.path !== path))
    throw new Error("get_daily_http_observations received observations for a different path.");
  return page;
}

/** The Eve tools' settings, read when a tool runs so the token never enters a durable tool descriptor. */
export function dailyEvidenceConfig(env: NodeJS.ProcessEnv, signal?: AbortSignal): DailyEvidenceConfig {
  const { LAB_BASE_URL: baseUrl, LAB_DAILY_CAPTURE_TOKEN: token, LAB_DAILY_CAPTURE_ID: captureId } = env;
  const evidenceSha256 = env.LAB_DAILY_EVIDENCE_SHA256;
  if (!baseUrl || !token || !captureId || !evidenceSha256)
    throw new Error(
      "Configure LAB_BASE_URL, LAB_DAILY_CAPTURE_TOKEN, LAB_DAILY_CAPTURE_ID, and LAB_DAILY_EVIDENCE_SHA256 before running the Daily evidence tools.",
    );
  return { baseUrl, token, captureId, evidenceSha256, signal };
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function request<T extends { captureId: string; evidenceSha256: string }>(
  tool: string,
  path: string,
  query: Record<string, string | number | undefined>,
  config: DailyEvidenceConfig,
  schema: Schema<T>,
): Promise<T> {
  const url = endpoint(tool, path, config);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));

  // One deadline covers connecting, the response headers, and the whole body.
  const deadline = AbortSignal.timeout(5_000);
  const signal = config.signal ? AbortSignal.any([deadline, config.signal]) : deadline;
  const stopped = () =>
    deadline.aborted ? `${tool} timed out after 5 seconds.` : config.signal?.aborted ? `${tool} was cancelled.` : undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(stopped() ?? `${tool} could not reach the lab service. Check LAB_BASE_URL and that pnpm dev is running.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      stopped() ??
        (response.ok
          ? `${tool} received invalid JSON from the lab service.`
          : `${tool} received HTTP ${response.status} from the lab service with no readable error.`),
    );
  }
  if (!response.ok) {
    // The service's explanation, such as an expired grant or a changed capture file.
    const failure = dailyEvidenceErrorSchema.safeParse(body);
    const detail = failure.success
      ? [failure.data.error.code, failure.data.error.message].filter(Boolean).join(": ").slice(0, 500)
      : "no readable error";
    throw new Error(`${tool} received HTTP ${response.status} from the lab service (${detail}).`);
  }
  const output = schema.safeParse(body);
  if (!output.success) throw new Error(`${tool} received invalid evidence from the lab service.`);
  if (output.data.captureId !== config.captureId || output.data.evidenceSha256 !== config.evidenceSha256)
    throw new Error(
      `${tool} received records from capture ${output.data.captureId} (evidence ${output.data.evidenceSha256.slice(0, 12)}), ` +
        `not the configured ${config.captureId} (evidence ${config.evidenceSha256.slice(0, 12)}).`,
    );
  return output.data;
}

function endpoint(tool: string, path: string, config: DailyEvidenceConfig) {
  if (!config.token.trim()) throw new Error(`${tool} requires a capture access token (LAB_DAILY_CAPTURE_TOKEN).`);
  if (!dailyCaptureIdSchema.safeParse(config.captureId).success)
    throw new Error(`${tool} requires the expected capture ID (LAB_DAILY_CAPTURE_ID).`);
  if (!/^[0-9a-f]{64}$/.test(config.evidenceSha256))
    throw new Error(`${tool} requires the expected evidence SHA-256 (LAB_DAILY_EVIDENCE_SHA256).`);
  try {
    const url = new URL(path, config.baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Reported below.
  }
  throw new Error(`${tool} requires LAB_BASE_URL to be an absolute HTTP or HTTPS URL.`);
}

function issue(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const first = error.issues[0];
  return `${first?.path.join(".") || "input"} ${first?.message ?? "is invalid"}`;
}

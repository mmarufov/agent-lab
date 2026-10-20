import { getLogsInputSchema, getLogsOutputSchema, type DeploymentLog, type GetLogsInput } from "@agent-lab/contracts";

export interface GetLogsConfig {
  baseUrl: string;
  trialToken: string;
}

// This function knows only the public HTTP contract. Database access and trial
// creation belong to the trusted service/runner, not to the agent's tool.
export async function getLogs(input: GetLogsInput, config: GetLogsConfig): Promise<DeploymentLog[]> {
  const parsedInput = getLogsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new Error("getLogs requires a deploymentId containing 1 to 100 characters.");
  }
  if (!config.trialToken.trim()) {
    throw new Error("getLogs requires LAB_TRIAL_TOKEN in its runtime configuration.");
  }

  let url: URL;
  try {
    url = new URL("/api/tools/get-logs", config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol.");
  } catch {
    throw new Error("getLogs requires LAB_BASE_URL to be an absolute HTTP or HTTPS URL.");
  }
  url.searchParams.set("deploymentId", parsedInput.data.deploymentId);

  // The same deadline covers both connecting and reading the response body.
  const signal = AbortSignal.timeout(5_000);
  const timeoutMessage = "getLogs request timed out after 5 seconds.";
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.trialToken}` },
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? timeoutMessage : "getLogs could not reach the lab service. Check LAB_BASE_URL and that pnpm dev is running.");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const hint = response.status === 401 ? " Check LAB_TRIAL_TOKEN."
      : response.status === 404 ? " Deployment not found in this trial." : "";
    throw new Error(`getLogs received HTTP ${response.status} from the lab service.${hint}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(signal.aborted ? timeoutMessage : "getLogs received invalid JSON from the lab service.");
  }
  const output = getLogsOutputSchema.safeParse(body);
  if (!output.success) throw new Error("getLogs received invalid log data from the lab service.");
  if (output.data.logs.some((log) => log.deploymentId !== parsedInput.data.deploymentId)) {
    throw new Error("getLogs received logs for a different deployment.");
  }
  return output.data.logs;
}

import { getLogsInputSchema, getLogsOutputSchema } from "@agent-lab/contracts";
import { json, withTrial } from "@/lib/lab-http";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withTrial(request, async (lab, trialId) => {
    const params = new URL(request.url).searchParams;
    const input = getLogsInputSchema.safeParse(Object.fromEntries(params));
    if (!input.success || params.getAll("deploymentId").length !== 1) {
      return json({ error: {
        code: "invalid_input",
        message: "Expected one deploymentId containing 1 to 100 characters, with no other query parameters.",
      } }, 400);
    }
    return json(getLogsOutputSchema.parse({
      logs: await lab.getLogs(trialId, input.data.deploymentId),
    }));
  });
}

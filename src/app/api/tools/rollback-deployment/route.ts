import { rollbackInputSchema } from "@agent-lab/contracts";
import { json, withTrial } from "@/lib/lab-http";

export const runtime = "nodejs";

export function POST(request: Request) {
  return withTrial(request, async (lab, trialId) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: "invalid_input", message: "Expected a JSON body." } }, 400);
    }
    const input = rollbackInputSchema.safeParse(body);
    if (!input.success) {
      return json({ error: { code: "invalid_input", message: "Expected targetDeploymentId and an optional integer expectedRevision." } }, 400);
    }
    return json({ action: await lab.rollback(trialId, input.data) });
  });
}

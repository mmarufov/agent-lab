import { json, withTrial } from "@/lib/lab-http";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withTrial(request, async (lab, trialId) => json(await lab.getState(trialId)));
}

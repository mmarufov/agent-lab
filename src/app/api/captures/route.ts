import { dailyCapturesDir, listDailyCaptures } from "@agent-lab/lab/daily-evidence";
import { guard, failure, response } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recorded Daily captures on this machine that the launch form can offer. Each
// is verified the way an investigation would read it. The response is an
// explicit metadata allowlist: no paths, file contents, hashes, or manifests.
export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    return response({ captures: await listDailyCaptures(dailyCapturesDir()) });
  } catch {
    return failure("Saved recordings could not be listed. Check the captures folder on this machine.", 503);
  }
}

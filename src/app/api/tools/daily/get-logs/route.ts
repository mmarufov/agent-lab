import { dailyCapturesDir } from "@agent-lab/lab/daily-evidence";
import { dailyEvidenceResponse } from "@agent-lab/lab/daily-tools";
import { pool } from "@/lib/server/data";
import { guard } from "@/lib/server/http";

export const runtime = "nodejs";

// Recorded application logs from the one Daily capture the bearer token's
// access grant selects. Reads files on this machine only.
export async function GET(request: Request) {
  return guard(request) ?? dailyEvidenceResponse(request, "get_daily_logs", { pool, capturesDir: dailyCapturesDir() });
}

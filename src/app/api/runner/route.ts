import { createJobStore } from "@agent-lab/lab/jobs";
import { pool } from "@/lib/server/data";
import {
  executionEnabled,
  guard,
  response,
  readError,
} from "@/lib/server/http";

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const jobs = createJobStore(pool());
    const state = await jobs.availability();
    return response({
      ...state,
      enabled: executionEnabled(),
      activeJob: state.activeJobId ? await jobs.get(state.activeJobId) : null,
    });
  } catch (error) {
    return readError(error);
  }
}

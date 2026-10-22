import { recordIdSchema } from "@agent-lab/contracts";
import { createJobStore } from "@agent-lab/lab/jobs";
import { pool } from "@/lib/server/data";
import { guard, failure, response, readError } from "@/lib/server/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const denied = guard(request);
  if (denied) return denied;
  const { jobId } = await params;
  if (!recordIdSchema.safeParse(jobId).success)
    return failure("Operation not found.", 404);
  try {
    return response(await createJobStore(pool()).get(jobId));
  } catch (error) {
    return readError(error);
  }
}

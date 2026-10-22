import { recordIdSchema } from "@agent-lab/contracts";
import { webStore } from "@/lib/server/data";
import { guard, failure, response, readError } from "@/lib/server/http";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const denied = guard(request);
  if (denied) return denied;
  const { runId } = await context.params;
  if (!recordIdSchema.safeParse(runId).success)
    return failure("Invalid investigation ID.");
  try {
    return response(await webStore().get(runId));
  } catch (error) {
    return readError(error);
  }
}

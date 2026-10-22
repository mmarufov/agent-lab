import { recordIdSchema } from "@agent-lab/contracts";
import { snapshotStream } from "@agent-lab/lab/stream";
import { webStore } from "@/lib/server/data";
import { guard, failure, readError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const load = () => webStore().get(runId);
    const initial = await load();
    return new Response(
      snapshotStream({
        initial,
        load,
        signal: request.signal,
        settled: (run) =>
          run.status !== "running" &&
          !run.activeJobId &&
          !run.reviews.some((review) => review.status === "running"),
      }),
      {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch (error) {
    return readError(error);
  }
}

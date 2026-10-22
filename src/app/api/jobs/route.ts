import { executionRequestSchema } from "@agent-lab/contracts";
import { createJobStore, JobError } from "@agent-lab/lab/jobs";
import { pool } from "@/lib/server/data";
import { guard, failure, response, readError } from "@/lib/server/http";

export async function POST(request: Request) {
  const denied = guard(request, true);
  if (denied) return denied;
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 2_048) return failure("Request is too large.", 413);
    body = JSON.parse(text);
  } catch {
    return failure("A JSON command is required.");
  }
  const parsed = executionRequestSchema.safeParse(body);
  if (!parsed.success)
    return failure("Choose a valid case, deployment, or saved investigation; use exactly one selector.");
  try {
    return response(await createJobStore(pool()).submit(parsed.data), 202);
  } catch (error) {
    if (error instanceof JobError)
      return failure(
        error.message,
        error.code === "offline" ? 503 : error.code === "invalid" ? 422 : 409,
      );
    return readError(error);
  }
}

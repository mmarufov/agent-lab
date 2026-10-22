import { runListInputSchema } from "@agent-lab/contracts";
import { webStore } from "@/lib/server/data";
import { guard, failure, response, readError } from "@/lib/server/http";
export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const parsed = runListInputSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) return failure("Invalid run filters.");
  try {
    return response(await webStore().list(parsed.data));
  } catch (error) {
    return readError(error);
  }
}

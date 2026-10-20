import "server-only";
import { createLab, LabError } from "@agent-lab/lab";
import { createPool } from "@agent-lab/lab/database";

const serverGlobal = globalThis as typeof globalThis & { labPool?: ReturnType<typeof createPool> };

export async function withTrial(
  request: Request,
  operation: (lab: ReturnType<typeof createLab>, trialId: string) => Promise<Response>,
) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: { code: "unauthorized", message: "A trial token is required." } }, 401);
  }
  try {
    const lab = createLab(serverGlobal.labPool ??= createPool());
    const trialId = await lab.resolveTrialToken(authorization.slice(7));
    if (!trialId) return json({ error: { code: "unauthorized", message: "Invalid trial token." } }, 401);
    return await operation(lab, trialId);
  } catch (error) {
    if (error instanceof LabError) {
      const status = { not_found: 404, stale_revision: 409, invalid_target: 422 }[error.code];
      return json({ error: { code: error.code, message: error.message } }, status);
    }
    console.error("Lab request failed. Check database configuration and availability.");
    return json({ error: { code: "internal_error", message: "The lab service could not complete the request." } }, 500);
  }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

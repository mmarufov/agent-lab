import "server-only";
import { localHost } from "./data";
export function response(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function failure(message: string, status = 400) {
  return response({ error: { message } }, status);
}
export function guard(request: Request, mutate = false) {
  const host = request.headers.get("host");
  if (process.env.VERCEL || !localHost(host))
    return failure("The local workbench is not available on this host.", 403);
  if (mutate) {
    if (!executionEnabled())
      return failure("Local execution is disabled.", 403);
    if (
      request.headers.get("origin") !== `http://${host}` ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return failure("A same-origin JSON request is required.", 403);
  }
  return null;
}
export function executionEnabled() {
  return (
    !process.env.VERCEL &&
    (process.env.LAB_LOCAL_EXECUTION === "1" ||
      (process.env.NODE_ENV === "development" &&
        process.env.LAB_LOCAL_EXECUTION !== "0"))
  );
}
export function readError(error: unknown) {
  return error instanceof Error && /not found/i.test(error.message)
    ? failure("This record was not found.", 404)
    : failure(
        "The local database is unavailable. Check PostgreSQL and migrations.",
        503,
      );
}
